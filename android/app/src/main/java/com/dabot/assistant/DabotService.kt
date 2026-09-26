package com.dabot.assistant

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * El cerebro local de DABOT. Vive como servicio en primer plano con
 * micrófono, así Android no lo mata con la pantalla atenuada.
 *
 *   reposo (Vosk escucha "Dabot") → escuchando (reconocedor del sistema)
 *   → pensando (POST /api/voice/command) → hablando → reposo
 *
 * Los anuncios del servidor (preguntas nuevas, fix terminado…) se encolan y
 * se dicen en cuanto DABOT está libre. Si lo dicho espera respuesta, vuelve a
 * escuchar sin necesidad de decir "Dabot".
 */
class DabotService : Service() {
    private data class Utterance(val text: String, val display: String, val listen: Boolean)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val main = Handler(Looper.getMainLooper())
    private lateinit var settings: Settings
    private lateinit var speaker: Speaker
    private lateinit var listener: CommandListener
    private lateinit var wake: WakeWord
    private lateinit var server: Server
    private var tone: ToneGenerator? = null

    private val queue = ArrayDeque<Utterance>()
    private var branchSearch: Job? = null
    private var speakingId: String? = null
    private var listenAfterSpeech = false
    private var greeted = false

    private val mode: Mode get() = Dabot.state.value.mode

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (!startInForeground()) {
            stopSelf()
            return
        }
        settings = Settings(this)
        tone = runCatching { ToneGenerator(AudioManager.STREAM_MUSIC, 70) }.getOrNull()
        speaker = Speaker(this, settings,
            onWord = { Dabot.update { it.copy(wordTick = it.wordTick + 1) } },
            onDone = ::onSpoken)
        listener = CommandListener(this, settings,
            onLevel = { level -> Dabot.update { it.copy(micLevel = level) } },
            onPartial = { text -> Dabot.update { it.copy(heard = text) } },
            onFinal = ::onHeard,
            onNothing = { if (mode == Mode.LISTENING) goIdle() },
            onError = { msg -> sayNext(msg, listen = false) })
        wake = WakeWord(this,
            onWake = ::onWake,
            onError = { msg -> Dabot.update { it.copy(wakeError = msg, wakeListening = false) } },
            onHeard = { text -> Dabot.update { it.copy(wakeHeard = text) } },
            wide = { settings.wakeWide })
        server = Server(settings, onAnnouncement = ::onAnnouncement, onConnection = ::onConnection)

        scope.launch { Dabot.actions.collect(::handle) }
        wake.load {
            Dabot.update { it.copy(wakeReady = true, wakeError = null) }
            if (mode == Mode.IDLE) startWake()
        }
        server.connect()
        goIdle()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        scope.cancel()
        main.removeCallbacksAndMessages(null)
        if (::server.isInitialized) {
            server.stop()
            wake.release()
            listener.destroy()
            speaker.shutdown()
        }
        tone?.release()
        Dabot.update { it.copy(mode = Mode.STARTING, connected = false) }
        super.onDestroy()
    }

    // -------------------------------------------------------------------------
    // Estados
    // -------------------------------------------------------------------------

    private fun setMode(m: Mode) = Dabot.update { it.copy(mode = m, micLevel = 0f) }

    private fun goIdle() {
        if (queue.isNotEmpty()) return speakNext()
        setMode(Mode.IDLE)
        startWake()
    }

    /**
     * El detector arranca medio segundo después de volver a reposo: si abre el micrófono
     * mientras el reconocedor de Google aún no lo suelta, Android puede darle silencio.
     * Por la misma razón se reinicia cada pocos minutos en reposo.
     */
    private fun startWake() {
        main.removeCallbacks(wakeStarter)
        main.postDelayed(wakeStarter, 600)
    }

    private val wakeStarter = Runnable {
        if (settings.wakeEnabled && wake.ready && mode == Mode.IDLE && !wake.running) {
            wake.start()
            Dabot.update { it.copy(wakeListening = wake.running) }
        }
        main.removeCallbacks(wakeRefresher)
        main.postDelayed(wakeRefresher, WAKE_REFRESH_MS)
    }

    private val wakeRefresher: Runnable = object : Runnable {
        override fun run() {
            if (mode == Mode.IDLE && wake.running) {
                stopWake()
                startWake() // wakeStarter vuelve a programar este reinicio
            } else {
                main.postDelayed(this, WAKE_REFRESH_MS)
            }
        }
    }

    private fun stopWake() {
        main.removeCallbacks(wakeStarter)
        wake.stop()
        Dabot.update { it.copy(wakeListening = false) }
    }

    private fun onWake(trailing: Boolean) {
        if (mode != Mode.IDLE) return
        Dabot.touch()
        stopWake()
        // Frase de un tirón ("Dabot arregla…"): el comando lo oyó el detector, no el reconocedor.
        if (trailing) sayNext("Dime.", listen = true) else startListening()
    }

    private fun startListening() {
        stopWake()
        speakingId = null
        speaker.stop()
        setMode(Mode.LISTENING)
        Dabot.update { it.copy(heard = "") }
        tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 120)
        // Que el pitido no entre en la grabación.
        main.postDelayed({ if (mode == Mode.LISTENING) listener.listen() }, 200)
    }

    private fun onHeard(text: String) {
        Dabot.touch()
        Dabot.update { it.copy(heard = text) }
        setMode(Mode.THINKING)
        val s = Dabot.state.value
        val focus = s.decision?.jobId ?: s.job?.id
        scope.launch {
            try {
                apply(server.command(text, focus), front = true)
            } catch (e: Exception) {
                Log.w(TAG, "Comando fallido", e)
                sayNext("No llego al servidor. ${e.message ?: ""}", listen = false, front = true)
                return@launch
            }
            speakNext()
        }
    }

    // -------------------------------------------------------------------------
    // Voz
    // -------------------------------------------------------------------------

    /** Dice algo en cuanto termine lo que esté diciendo (errores, "Dime", pruebas). */
    private fun sayNext(text: String, listen: Boolean, front: Boolean = false) {
        enqueue(Utterance(text, text, listen), front)
        if (mode != Mode.SPEAKING) speakNext()
    }

    private fun enqueue(u: Utterance, front: Boolean) {
        if (u.text.isBlank()) return
        if (front) queue.addFirst(u) else queue.addLast(u)
    }

    private fun speakNext() {
        val u = queue.removeFirstOrNull() ?: return goIdle()
        stopWake()
        setMode(Mode.SPEAKING)
        Dabot.update { it.copy(said = u.display) }
        listenAfterSpeech = u.listen
        speakingId = speaker.say(u.text)
    }

    private fun onSpoken(id: String) {
        if (id != speakingId) return
        speakingId = null
        when {
            queue.isNotEmpty() -> speakNext()
            listenAfterSpeech -> startListening()
            else -> goIdle()
        }
    }

    // -------------------------------------------------------------------------
    // Servidor
    // -------------------------------------------------------------------------

    /** Aplica una respuesta o anuncio: tarjeta del job, decisión pendiente y frase a decir. */
    private fun apply(r: VoiceReply, front: Boolean) {
        Dabot.update { s ->
            val j = r.job
            // Respuesta y anuncio viajan por conexiones distintas: si esto es más viejo que lo ya visto, no toca el estado.
            if (j != null && j.updatedAt < (s.seen[j.id] ?: 0L)) return@update s
            var decisions = s.decisions
            var seen = s.seen
            if (j != null) {
                seen = seen + (j.id to j.updatedAt)
                decisions = if (r.decision != null) decisions + (j.id to r.decision) else decisions - j.id
            } else if (r.decision != null) {
                decisions = decisions + (r.decision.jobId to r.decision)
            }
            val jobs = merge(s.jobs, j)
            // En pantalla: el job de la pregunta nueva; si no la hay, el que siga esperando algo; si no, el último tocado.
            val shown = when {
                r.decision != null -> j ?: jobs.find { it.id == r.decision.jobId } ?: s.job
                decisions.isNotEmpty() -> jobs.find { it.id == decisions.keys.last() } ?: s.job
                else -> j ?: s.job
            }
            s.copy(job = shown, decisions = decisions, seen = seen, jobs = jobs)
        }
        enqueue(Utterance(r.say, r.display ?: r.say, r.listen), front)
    }

    private fun onAnnouncement(r: VoiceReply) {
        Dabot.touch()
        apply(r, front = false)
        if (mode == Mode.IDLE || mode == Mode.STARTING) speakNext()
    }

    private fun onConnection(connected: Boolean, error: String?) {
        val was = Dabot.state.value.connected
        Dabot.update { it.copy(connected = connected, connectionError = error) }
        if (!connected || was) return
        scope.launch {
            val st = runCatching { server.state() }.getOrElse {
                Log.w(TAG, "No se pudo leer /state", it)
                return@launch
            }
            Dabot.update { s ->
                val d = st.focusDecision
                s.copy(
                    jobs = st.jobs,
                    job = st.focusJob ?: s.job,
                    decisions = if (d != null) mapOf(d.jobId to d) else emptyMap(),
                    seen = st.jobs.associate { it.id to it.updatedAt },
                )
            }
            if (!greeted) {
                greeted = true
                enqueue(Utterance(st.say, st.say, listen = false), front = false)
                if (mode == Mode.IDLE || mode == Mode.STARTING) speakNext()
            }
        }
    }

    private fun merge(list: List<VoiceJob>, job: VoiceJob?): List<VoiceJob> {
        if (job == null) return list
        return (listOf(job) + list.filter { it.id != job.id }).sortedByDescending { it.updatedAt }.take(12)
    }

    // -------------------------------------------------------------------------
    // Pantalla
    // -------------------------------------------------------------------------

    private fun handle(action: Action) {
        Dabot.touch()
        when (action) {
            Action.Talk -> when (mode) {
                Mode.SPEAKING -> {
                    // Interrumpir: lo pendiente sigue en pantalla.
                    queue.clear()
                    startListening()
                }
                Mode.LISTENING -> {
                    listener.cancel()
                    goIdle()
                }
                Mode.THINKING -> Unit
                Mode.IDLE, Mode.STARTING -> startListening()
            }
            Action.StopTalking -> {
                queue.clear()
                speakingId = null
                speaker.stop()
                listener.cancel()
                goIdle()
            }
            is Action.Decide -> {
                listener.cancel()
                queue.clear()
                speakingId = null
                speaker.stop()
                stopWake()
                setMode(Mode.THINKING)
                scope.launch {
                    try {
                        apply(server.decide(action.jobId, action.optionId), front = true)
                    } catch (e: Exception) {
                        sayNext("No llego al servidor. ${e.message ?: ""}", listen = false, front = true)
                        return@launch
                    }
                    speakNext()
                }
            }
            Action.SettingsChanged -> {
                speaker.configure()
                greeted = false
                Dabot.update { it.copy(connected = false) }
                server.connect()
                if (!settings.wakeEnabled) stopWake() else startWake()
            }
            is Action.Test -> sayNext(action.text, listen = false)
            is Action.SearchBranches -> {
                // Mientras escribes, solo cuenta la última búsqueda.
                branchSearch?.cancel()
                Dabot.update { it.copy(branchLoading = true) }
                branchSearch = scope.launch {
                    delay(250)
                    val (list, error) = try {
                        server.branches(action.query)
                    } catch (e: Exception) {
                        emptyList<String>() to "No llego al servidor: ${e.message}"
                    }
                    Dabot.update { it.copy(branchResults = list, branchError = error, branchLoading = false) }
                }
            }
        }
    }

    private fun startInForeground(): Boolean {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "DABOT escuchando", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("DABOT")
            .setContentText("Escuchando «Dabot»")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(1, notification)
            }
            true
        } catch (e: Exception) {
            // Android 14 no deja abrir el micrófono desde segundo plano: la Activity lo relanza al volver.
            Log.e(TAG, "No se pudo iniciar en primer plano", e)
            false
        }
    }

    companion object {
        private const val TAG = "Dabot"
        private const val CHANNEL = "dabot"
        private const val WAKE_REFRESH_MS = 4 * 60_000L
    }
}
