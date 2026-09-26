package com.dabot.assistant

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log

/**
 * El comando en sí ("arregla el ticket AN-1234 desde develop") lo transcribe
 * el reconocedor del sistema (Google en la Tab A8): entiende claves, números y
 * nombres de rama mucho mejor que el modelo offline, que solo sirve para "Dabot".
 */
class CommandListener(
    private val context: Context,
    private val settings: Settings,
    private val onLevel: (Float) -> Unit,
    private val onPartial: (String) -> Unit,
    private val onFinal: (String) -> Unit,
    /** No se oyó nada o no se entendió: vuelve a reposo sin decir nada. */
    private val onNothing: () -> Unit,
    private val onError: (String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var active = false
    private val watchdog = Runnable {
        if (active) {
            Log.w(TAG, "El reconocedor no respondió: se cancela")
            finish()
            onNothing()
        }
    }

    val available: Boolean get() = SpeechRecognizer.isRecognitionAvailable(context)

    fun listen() {
        if (!available) {
            onError("Este dispositivo no tiene reconocedor de voz (instala o activa la app de Google)")
            return
        }
        val sr = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also {
            it.setRecognitionListener(listener)
            recognizer = it
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, settings.language)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, settings.language)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            // Dejar pensar entre "desde" y el nombre de la rama.
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L)
        }
        active = true
        main.removeCallbacks(watchdog)
        main.postDelayed(watchdog, 20_000)
        sr.startListening(intent)
    }

    fun cancel() {
        if (!active) return
        recognizer?.cancel()
        finish()
    }

    fun destroy() {
        finish()
        recognizer?.destroy()
        recognizer = null
    }

    private fun finish() {
        active = false
        main.removeCallbacks(watchdog)
        onLevel(0f)
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = Unit
        override fun onBeginningOfSpeech() = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = onLevel(0f)
        override fun onEvent(eventType: Int, params: Bundle?) = Unit

        override fun onRmsChanged(rmsdB: Float) {
            // Rango típico -2..10 dB.
            onLevel(((rmsdB + 2f) / 12f).coerceIn(0f, 1f))
        }

        override fun onPartialResults(partialResults: Bundle?) {
            best(partialResults)?.let(onPartial)
        }

        override fun onResults(results: Bundle?) {
            if (!active) return
            finish()
            val text = best(results)
            if (text.isNullOrBlank()) onNothing() else onFinal(text)
        }

        override fun onError(error: Int) {
            if (!active) return
            finish()
            when (error) {
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> onNothing()
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_CLIENT -> {
                    // Estado atascado: se recrea en el próximo listen().
                    recognizer?.destroy()
                    recognizer = null
                    onNothing()
                }
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER ->
                    onError("El reconocedor de voz necesita internet")
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> onError("Falta el permiso de micrófono")
                SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
                    onError("El reconocedor no tiene el idioma ${settings.language}")
                else -> onError("Error del reconocedor ($error)")
            }
        }
    }

    private fun best(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()

    companion object {
        private const val TAG = "DabotListen"
    }
}
