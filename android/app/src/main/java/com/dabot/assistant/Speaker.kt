package com.dabot.assistant

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/** La voz de DABOT: la síntesis del sistema, eligiendo la mejor voz instalada del idioma. */
class Speaker(
    context: Context,
    private val settings: Settings,
    private val onWord: () -> Unit,
    /**
     * Terminó (o falló) una frase. No se llama `onDone`: dentro del listener de la síntesis
     * ese nombre es su propio método, y la llamada se reencolaba a sí misma para siempre.
     */
    private val onFinished: (utteranceId: String) -> Unit,
    /** Problema de la síntesis para mostrar en pantalla (null = todo bien). */
    private val onProblem: (String?) -> Unit = {},
) {
    private val main = Handler(Looper.getMainLooper())
    private val ids = AtomicInteger()
    private var ready = false
    private val pending = mutableListOf<Pair<String, String>>()
    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
        main.post {
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
                configure()
                pending.forEach { (text, id) -> speakNow(text, id) }
            } else {
                Log.e(TAG, "La síntesis de voz no arrancó ($status)")
                onProblem("La síntesis de voz no arrancó: revisa Ajustes → Administración general → Texto a voz")
                pending.forEach { (_, id) -> onFinished(id) }
            }
            pending.clear()
        }
    }

    init {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit
            override fun onDone(utteranceId: String?) {
                utteranceId?.let { id -> main.post { onFinished(id) } }
            }
            @Deprecated("API antigua; se mantiene por compatibilidad")
            override fun onError(utteranceId: String?) {
                utteranceId?.let { id -> main.post { onFinished(id) } }
            }
            override fun onError(utteranceId: String?, errorCode: Int) {
                Log.e(TAG, "Error de síntesis $errorCode")
                main.post {
                    onProblem(
                        if (errorCode == TextToSpeech.ERROR_NOT_INSTALLED_YET) "La voz en español aún se está descargando en la tablet"
                        else "Error de la voz ($errorCode): prueba otra voz en Ajustes → Texto a voz",
                    )
                    utteranceId?.let(onFinished)
                }
            }
            override fun onStop(utteranceId: String?, interrupted: Boolean) {
                utteranceId?.let { id -> main.post { onFinished(id) } }
            }
            override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) {
                main.post(onWord)
            }
        })
    }

    /** Vuelve a leer idioma y velocidad de los ajustes. */
    fun configure() {
        if (!ready) return
        val locale = Locale.forLanguageTag(settings.language)
        var result = tts.setLanguage(locale)
        if (result < TextToSpeech.LANG_AVAILABLE) result = tts.setLanguage(Locale(locale.language))
        onProblem(
            when (result) {
                TextToSpeech.LANG_MISSING_DATA -> "Falta la voz en español: Ajustes → Administración general → Texto a voz → instalar datos"
                TextToSpeech.LANG_NOT_SUPPORTED -> "El motor de voz no tiene español: elige «Servicios de voz de Google» en Ajustes → Texto a voz"
                else -> null
            },
        )
        tts.setSpeechRate(settings.speechRate)
        pickVoice(locale)?.let { tts.voice = it }
    }

    /** Mejor voz local del idioma y país; si no hay del país, cualquiera en español. */
    private fun pickVoice(locale: Locale): Voice? {
        val voices = runCatching { tts.voices }.getOrNull().orEmpty()
            .filter { it.locale.language == locale.language && !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
        return voices.sortedWith(
            compareByDescending<Voice> { it.locale.country == locale.country }
                .thenBy { it.isNetworkConnectionRequired }
                .thenByDescending { it.quality },
        ).firstOrNull()
    }

    /** Encola una frase; devuelve su id (llega a onFinished al terminar). */
    fun say(text: String): String {
        val id = "u${ids.incrementAndGet()}"
        if (ready) speakNow(text, id) else pending += text to id
        return id
    }

    private fun speakNow(text: String, id: String) {
        val params = Bundle().apply { putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id) }
        val result = tts.speak(text, TextToSpeech.QUEUE_ADD, params, id)
        if (result != TextToSpeech.SUCCESS) {
            onProblem("La voz no pudo hablar (error $result)")
            main.post { onFinished(id) }
        }
    }

    fun stop() {
        tts.stop()
    }

    fun shutdown() {
        tts.stop()
        tts.shutdown()
    }

    companion object {
        private const val TAG = "DabotSpeaker"
    }
}
