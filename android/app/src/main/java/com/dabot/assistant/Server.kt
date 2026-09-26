package com.dabot.assistant

import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * API de DABOT en Bugs Manager (/api/voice). Los comandos van por REST; los
 * anuncios (preguntas nuevas, fix terminado…) llegan por SSE y se reconecta
 * solo si la red o el servidor caen.
 */
class Server(
    private val settings: Settings,
    private val onAnnouncement: (VoiceReply) -> Unit,
    private val onConnection: (connected: Boolean, error: String?) -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()
    private val sseClient = client.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private var source: EventSource? = null
    private var retryMs = 2_000L
    private var stopped = true

    private fun url(path: String) = "${settings.serverUrl.trimEnd('/')}/api/voice$path"

    private fun Request.Builder.auth(): Request.Builder {
        val token = settings.token
        return if (token.isNotEmpty()) header("Authorization", "Bearer $token") else this
    }

    suspend fun state(): VoiceState = withContext(Dispatchers.IO) {
        VoiceState.from(call(Request.Builder().url(url("/state")).auth().get().build()))
    }

    suspend fun command(text: String, jobId: String?): VoiceReply = withContext(Dispatchers.IO) {
        val body = JSONObject().put("text", text).apply { if (jobId != null) put("jobId", jobId) }
        VoiceReply.from(call(post(url("/command"), body)))
    }

    suspend fun decide(jobId: String, option: String): VoiceReply = withContext(Dispatchers.IO) {
        VoiceReply.from(call(post(url("/jobs/$jobId/decide"), JSONObject().put("option", option))))
    }

    /** Ramas del remoto que contienen `query` (vacío = las primeras, develop/main/release primero). */
    suspend fun branches(query: String): Pair<List<String>, String?> = withContext(Dispatchers.IO) {
        val u = url("/branches").toHttpUrl().newBuilder().addQueryParameter("q", query).build()
        val o = call(Request.Builder().url(u).auth().get().build())
        val arr = o.optJSONArray("branches")
        val list = if (arr == null) emptyList() else (0 until arr.length()).map { arr.getString(it) }
        list to o.optString("error").takeIf { it.isNotEmpty() }
    }

    private fun post(url: String, body: JSONObject): Request =
        Request.Builder().url(url).auth()
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

    private fun call(request: Request): JSONObject {
        client.newCall(request).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (res.code == 401) throw IOException("El servidor pide token: revisa VOICE_TOKEN en Ajustes")
            if (!res.isSuccessful) throw IOException("HTTP ${res.code}: ${text.take(160)}")
            return JSONObject(text)
        }
    }

    /** Abre (o reabre) el canal de anuncios. */
    fun connect() {
        stopped = false
        source?.cancel()
        if (!settings.configured) {
            onConnection(false, "Configura la dirección del servidor")
            return
        }
        val request = try {
            Request.Builder().url(url("/events")).auth().header("Accept", "text/event-stream").build()
        } catch (e: IllegalArgumentException) {
            onConnection(false, "Dirección inválida: ${settings.serverUrl}")
            return
        }
        source = EventSources.createFactory(sseClient).newEventSource(request, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                retryMs = 2_000L
                main.post { onConnection(true, null) }
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                if (type != "voice") return
                val reply = try {
                    VoiceReply.from(JSONObject(data))
                } catch (e: Exception) {
                    Log.w(TAG, "Anuncio ilegible: $data", e)
                    return
                }
                main.post { onAnnouncement(reply) }
            }

            override fun onClosed(eventSource: EventSource) = retry(eventSource, "El servidor cerró la conexión")

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                val why = when {
                    response?.code == 401 -> "Token incorrecto (VOICE_TOKEN)"
                    response != null -> "HTTP ${response.code}"
                    else -> t?.message ?: "sin conexión"
                }
                retry(eventSource, why)
            }
        })
    }

    private fun retry(from: EventSource, why: String) {
        if (from !== source) return // conexión vieja, ya reemplazada
        main.post {
            onConnection(false, why)
            if (stopped) return@post
            val wait = retryMs
            retryMs = (retryMs * 2).coerceAtMost(30_000L)
            main.postDelayed({ if (!stopped && from === source) connect() }, wait)
        }
    }

    fun stop() {
        stopped = true
        source?.cancel()
        source = null
    }

    companion object {
        private const val TAG = "DabotServer"
    }
}
