package com.dabot.assistant

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** Qué está haciendo DABOT; la cara y los colores salen de aquí. */
enum class Mode { STARTING, IDLE, LISTENING, THINKING, SPEAKING }

data class UiState(
    val mode: Mode = Mode.STARTING,
    val connected: Boolean = false,
    val connectionError: String? = null,
    /** Vosk cargado y escuchando "Dabot". */
    val wakeReady: Boolean = false,
    val wakeError: String? = null,
    /** El detector tiene el micrófono ahora mismo. */
    val wakeListening: Boolean = false,
    /** Lo último que oyó el detector (diagnóstico). */
    val wakeHeard: String = "",
    /** Nivel del micrófono mientras escucha un comando, 0..1. */
    val micLevel: Float = 0f,
    /** Se incrementa en cada palabra que dice la síntesis: mueve la boca. */
    val wordTick: Int = 0,
    /** Lo que DABOT oyó (parcial o final). */
    val heard: String = "",
    /** Lo último que DABOT dijo (texto de pantalla). */
    val said: String = "",
    val job: VoiceJob? = null,
    /** Decisiones pendientes por job (una pregunta nueva de otro job no borra la de este). */
    val decisions: Map<String, VoiceDecision> = emptyMap(),
    /** updatedAt más reciente visto por job: lo que llegue más viejo se ignora. */
    val seen: Map<String, Long> = emptyMap(),
    val jobs: List<VoiceJob> = emptyList(),
    /** Buscador de ramas (como el desplegable de Slack). */
    val branchResults: List<String> = emptyList(),
    val branchError: String? = null,
    val branchLoading: Boolean = false,
    /** Última interacción (para atenuar la pantalla). */
    val lastActivity: Long = System.currentTimeMillis(),
) {
    /** Lo que se le pregunta ahora sobre el job en pantalla. */
    val decision: VoiceDecision? get() = job?.let { decisions[it.id] }
}

/** Acciones de la pantalla hacia el servicio. */
sealed interface Action {
    data object Talk : Action
    data object StopTalking : Action
    data class Decide(val jobId: String, val optionId: String) : Action
    data object SettingsChanged : Action
    data class Test(val text: String) : Action
    data class SearchBranches(val query: String) : Action
}

/** Bus entre la Activity (pantalla) y DabotService (oído, voz y red). */
object Dabot {
    val state = MutableStateFlow(UiState())
    val actions = MutableSharedFlow<Action>(extraBufferCapacity = 16)

    fun update(block: (UiState) -> UiState) = state.update(block)

    fun touch() = state.update { it.copy(lastActivity = System.currentTimeMillis()) }
}
