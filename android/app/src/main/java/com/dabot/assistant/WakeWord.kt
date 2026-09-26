package com.dabot.assistant

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import org.vosk.android.StorageService
import java.io.IOException

/**
 * "Dabot" sin internet: Vosk con una gramática cerrada. "Dabot" no existe en
 * el vocabulario del modelo, pero "da bot" sí; las palabras señuelo absorben
 * frases parecidas ("dame el boli", "abre el bote") que sin ellas se leían
 * como la palabra de activación. Medido con voces sintéticas: 26/30 aciertos
 * y 1 falso positivo en 120 frases de oficina, decidiendo solo con resultados
 * finales (con parciales los falsos positivos se multiplicaban por diez).
 */
class WakeWord(
    private val context: Context,
    /** `trailing`: dijiste más cosas en la misma frase (el comando se perdió: hay que repetirlo). */
    private val onWake: (trailing: Boolean) -> Unit,
    private val onError: (String) -> Unit,
    /** Todo lo que el detector oye (diagnóstico en pantalla). */
    private val onHeard: (String) -> Unit = {},
    /** Detección amplia: basta "bot" (más aciertos, más falsos positivos). */
    private val wide: () -> Boolean = { false },
) {
    private var model: Model? = null
    private var recognizer: Recognizer? = null
    private var speech: SpeechService? = null
    private var loading = false

    val ready: Boolean get() = model != null
    val running: Boolean get() = speech != null

    /** Copia el modelo de assets al almacenamiento interno (solo la primera vez) y lo carga. */
    fun load(onReady: () -> Unit) {
        if (model != null) return onReady()
        if (loading) return
        loading = true
        StorageService.unpack(context, "model-es", "model",
            { m: Model ->
                loading = false
                model = m
                recognizer = Recognizer(m, SAMPLE_RATE, GRAMMAR)
                onReady()
            },
            { e: IOException ->
                loading = false
                Log.e(TAG, "No se pudo cargar el modelo", e)
                onError("No se pudo cargar el modelo de voz: ${e.message}")
            })
    }

    fun start() {
        val rec = recognizer ?: return
        if (speech != null) return
        try {
            speech = SpeechService(rec, SAMPLE_RATE).also { it.startListening(listener) }
        } catch (e: IOException) {
            Log.e(TAG, "Micrófono no disponible para Vosk", e)
            speech = null
            onError("Micrófono ocupado: ${e.message}")
        }
    }

    /** Suelta el micrófono (para que lo use el reconocedor de comandos o mientras habla). */
    fun stop() {
        speech?.let {
            it.stop()
            it.shutdown()
        }
        speech = null
        recognizer?.reset()
    }

    fun release() {
        stop()
        recognizer?.close()
        recognizer = null
        model?.close()
        model = null
    }

    private val listener = object : RecognitionListener {
        override fun onPartialResult(hypothesis: String?) {
            val text = hypothesis?.let { runCatching { JSONObject(it).optString("partial") }.getOrNull() }
            if (!text.isNullOrBlank()) onHeard("$text…")
        }
        override fun onResult(hypothesis: String?) = check(hypothesis)
        override fun onFinalResult(hypothesis: String?) = check(hypothesis)
        override fun onError(exception: Exception?) {
            Log.e(TAG, "Error de Vosk", exception)
            onError("Error del detector: ${exception?.message}")
        }
        override fun onTimeout() = Unit
    }

    private fun check(hypothesis: String?) {
        val text = hypothesis?.let { runCatching { JSONObject(it).optString("text") }.getOrNull() } ?: return
        if (text.isNotBlank()) onHeard(text)
        val match = (if (wide()) WAKE_WIDE else WAKE).find(text) ?: return
        val trailing = text.substring(match.range.last + 1).split(' ').any { it.isNotBlank() && it != "[unk]" }
        Log.i(TAG, "Palabra de activación: \"$text\" (trailing=$trailing)")
        onWake(trailing)
    }

    companion object {
        private const val TAG = "DabotWake"
        private const val SAMPLE_RATE = 16000f
        private val WAKE = Regex("\\bda bot\\b")
        private val WAKE_WIDE = Regex("\\bbot\\b")

        private val GRAMMAR: String = JSONArray(
            listOf("oye da bot", "hola da bot", "da bot") +
                ("el la de del da dar dame das lo los las un una uno oye hola bot bote robot abre abrir " +
                    "vamos voy va vaya todo todos no si sí que qué con por para es esta está bien buenos días " +
                    "david dado dato datos tabla tableta boli vaso agua base vuelta igual [unk]").split(' ')
        ).toString()
    }
}
