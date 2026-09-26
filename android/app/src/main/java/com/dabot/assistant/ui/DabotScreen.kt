package com.dabot.assistant.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dabot.assistant.Action
import com.dabot.assistant.Dabot
import com.dabot.assistant.Mode
import com.dabot.assistant.Settings
import com.dabot.assistant.UiState
import com.dabot.assistant.VoiceDecision
import com.dabot.assistant.VoiceJob
import kotlinx.coroutines.delay

object Palette {
    val bg = Color(0xFF0A0E14)
    val panel = Color(0xFF121821)
    val panelHigh = Color(0xFF1A222D)
    val line = Color(0xFF26303D)
    val text = Color(0xFFE6EDF3)
    val muted = Color(0xFF8B97A6)
    val idle = Color(0xFF45E0C0)
    val speaking = Color(0xFF6FF5D5)
    val listening = Color(0xFF5AB8FF)
    val thinking = Color(0xFFFFC857)
    val offline = Color(0xFF6B7280)
    val ok = Color(0xFF3FB950)
    val warn = Color(0xFFD29922)
    val bad = Color(0xFFF85149)
}

@Composable
fun DabotApp(
    settings: Settings,
    onSettingsSaved: () -> Unit,
    autostartGranted: () -> Boolean,
    requestAutostart: () -> Unit,
    batteryExempt: () -> Boolean,
    requestBatteryExemption: () -> Unit,
    setDimmed: (Boolean) -> Unit,
) {
    val state by Dabot.state.collectAsStateWithLifecycle()
    var showSettings by remember { mutableStateOf(!settings.configured) }

    // Atenuar tras un rato en reposo; cualquier actividad (voz, anuncio, toque) lo despierta.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(5_000)
            now = System.currentTimeMillis()
        }
    }
    val dimAfter = settings.dimMinutes * 60_000L
    val sleeping = dimAfter > 0 && !showSettings && state.mode == Mode.IDLE && now - state.lastActivity > dimAfter
    LaunchedEffect(sleeping) { setDimmed(sleeping) }

    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Palette.idle, onPrimary = Palette.bg, background = Palette.bg, surface = Palette.panel,
            onSurface = Palette.text, onBackground = Palette.text, secondary = Palette.listening,
        ),
    ) {
        BoxWithConstraints(
            Modifier
                .fillMaxSize()
                .background(Palette.bg)
                .pointerInput(sleeping) { detectTapGestures { if (sleeping) Dabot.touch() } },
        ) {
            val landscape = maxWidth > maxHeight
            if (landscape) {
                Row(Modifier.fillMaxSize().padding(24.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    FaceArea(state, sleeping, Modifier.weight(1.15f).fillMaxSize())
                    AnimatedVisibility(!sleeping, Modifier.weight(1f), enter = fadeIn(), exit = fadeOut()) {
                        SidePanel(state) { showSettings = true }
                    }
                }
            } else {
                Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    FaceArea(state, sleeping, Modifier.weight(1f).fillMaxWidth())
                    if (!sleeping) Box(Modifier.weight(1f)) { SidePanel(state) { showSettings = true } }
                }
            }
        }

        if (showSettings) {
            SettingsDialog(
                settings = settings,
                autostartGranted = autostartGranted,
                requestAutostart = requestAutostart,
                batteryExempt = batteryExempt,
                requestBatteryExemption = requestBatteryExemption,
                onDismiss = { if (settings.configured) showSettings = false },
                onSave = {
                    showSettings = false
                    onSettingsSaved()
                },
            )
        }
    }
}

@Composable
private fun FaceArea(state: UiState, sleeping: Boolean, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Face(
            mode = state.mode,
            connected = state.connected,
            sleeping = sleeping,
            micLevel = state.micLevel,
            wordTick = state.wordTick,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .pointerInput(Unit) {
                    detectTapGestures(
                        onTap = { Dabot.actions.tryEmit(Action.Talk) },
                        onLongPress = { Dabot.actions.tryEmit(Action.StopTalking) },
                    )
                },
        )
        val caption = when (state.mode) {
            Mode.STARTING -> "Arrancando…"
            Mode.LISTENING -> state.heard.ifBlank { "Te escucho…" }
            Mode.THINKING -> state.heard.ifBlank { "Pensando…" }
            Mode.SPEAKING -> state.said
            Mode.IDLE -> when {
                sleeping -> ""
                state.wakeError != null -> "Toca la cara para hablar"
                state.wakeReady -> "Di «Dabot» o toca la cara"
                else -> "Toca la cara para hablar"
            }
        }
        Text(
            caption,
            color = if (state.mode == Mode.LISTENING) Palette.listening else Palette.text.copy(alpha = if (state.mode == Mode.IDLE) 0.55f else 0.95f),
            fontSize = if (state.mode == Mode.SPEAKING) 22.sp else 20.sp,
            textAlign = TextAlign.Center,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().height(120.dp).padding(horizontal = 12.dp),
        )
    }
}

@Composable
private fun SidePanel(state: UiState, openSettings: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(20.dp))
            .background(Palette.panel)
            .border(1.dp, Palette.line, RoundedCornerShape(20.dp))
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        StatusBar(state, openSettings)
        WakeDiagnostics(state)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            val job = state.job
            val decision = state.decision
            if (job == null && decision == null) {
                Hint()
            } else {
                job?.let { JobCard(it) }
                decision?.let { DecisionPanel(it, state, enabled = state.mode != Mode.THINKING) }
            }
            if (state.said.isNotBlank() && state.mode != Mode.SPEAKING) {
                Labeled("DABOT dijo") { Text(state.said, color = Palette.text.copy(alpha = 0.85f), fontSize = 16.sp) }
            }
            if (state.heard.isNotBlank() && state.mode != Mode.LISTENING) {
                Labeled("Oí") { Text("«${state.heard}»", color = Palette.muted, fontSize = 16.sp) }
            }
            val others = state.jobs.filter { it.id != state.job?.id }
            if (others.isNotEmpty()) {
                Labeled("Otros jobs") { others.take(6).forEach { JobRow(it) } }
            }
        }
    }
}

@Composable
private fun StatusBar(state: UiState, openSettings: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        val (dot, label) = when {
            state.connected -> Palette.ok to "Conectado"
            state.connectionError != null -> Palette.bad to state.connectionError
            else -> Palette.warn to "Conectando…"
        }
        Box(Modifier.size(10.dp).clip(CircleShape).background(dot))
        Spacer(Modifier.size(8.dp))
        Text(label, color = Palette.muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        state.wakeError?.let { Text("Detector: sin «Dabot»", color = Palette.warn, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 8.dp)) }
        TextButton(onClick = openSettings) { Text("Ajustes", color = Palette.muted) }
    }
}

/** Qué oye el detector de «Dabot»: si al decirlo no aparece nada aquí, el micrófono no le llega. */
@Composable
private fun WakeDiagnostics(state: UiState) {
    val (color, label) = when {
        state.wakeError != null -> Palette.bad to state.wakeError
        !state.wakeReady -> Palette.warn to "Cargando detector de «Dabot»…"
        state.wakeListening -> Palette.ok to "Escuchando «Dabot»"
        else -> Palette.muted to "Detector en pausa"
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(color))
        Spacer(Modifier.size(8.dp))
        Text(label, color = Palette.muted, fontSize = 13.sp)
        if (state.wakeHeard.isNotBlank()) {
            Text("  ·  oyó «${state.wakeHeard}»", color = Palette.muted.copy(alpha = 0.8f), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun Hint() {
    Labeled("Prueba a decir") {
        listOf(
            "Dabot… arregla el ticket A N 1234",
            "Dabot… arregla el 1234 desde develop, ten en cuenta el datagrid",
            "Dabot… ¿cómo va todo?",
            "Dabot… dile a Claude que revise también el export",
        ).forEach { Text(it, color = Palette.text.copy(alpha = 0.8f), fontSize = 17.sp, modifier = Modifier.padding(vertical = 3.dp)) }
        Text(
            "Di «Dabot», espera el pitido y habla. Tras cada pregunta puedes responder sin volver a llamarlo.",
            color = Palette.muted, fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp),
        )
    }
}

@Composable
private fun JobCard(job: VoiceJob) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Palette.panelHigh).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(job.ticketKey, color = Palette.text, fontSize = 26.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.weight(1f))
            StatusChip(job)
        }
        job.summary?.let { Text(it, color = Palette.text.copy(alpha = 0.85f), fontSize = 17.sp, maxLines = 3, overflow = TextOverflow.Ellipsis) }
        if (job.status == "fixed") {
            job.issue?.let { Detail("Issue", it) }
            job.solution?.let { Detail("Solution", it) }
            if (job.prUrls.isNotEmpty()) Detail("PR", "${job.prUrls.size} abierto(s)")
        }
        if (job.status in setOf("failed", "cannot_fix")) job.failureReason?.let { Detail("Motivo", it) }
    }
}

@Composable
private fun StatusChip(job: VoiceJob) {
    val color = when (job.status) {
        "fixed" -> Palette.ok
        "failed", "cannot_fix" -> Palette.bad
        "discarded" -> Palette.muted
        "working", "triaging", "creating_worktree" -> Palette.listening
        else -> Palette.thinking // awaiting_*
    }
    Text(
        job.statusLabel,
        color = color,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.14f)).padding(horizontal = 12.dp, vertical = 5.dp),
    )
}

@Composable
private fun Detail(label: String, text: String) {
    Text(label.uppercase(), color = Palette.muted, fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 6.dp))
    Text(text, color = Palette.text.copy(alpha = 0.9f), fontSize = 15.sp, maxLines = 5, overflow = TextOverflow.Ellipsis)
}

@Composable
private fun DecisionPanel(d: VoiceDecision, state: UiState, enabled: Boolean) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).border(1.5.dp, Palette.thinking.copy(alpha = 0.6f), RoundedCornerShape(14.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("TE PREGUNTA", color = Palette.thinking, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        Text(d.question, color = Palette.text, fontSize = 19.sp)
        if (d.kind == "branch") {
            BranchPicker(d, state, enabled)
            return@Column
        }
        d.options.forEachIndexed { i, opt ->
            val primary = i == 0 && d.kind != "branch"
            val label = if (d.options.size > 2 || d.kind == "branch") "${i + 1} · ${opt.label}" else opt.label
            val onClick = { Dabot.actions.tryEmit(Action.Decide(d.jobId, opt.id)); Unit }
            if (primary) {
                Button(onClick, Modifier.fillMaxWidth().height(56.dp), enabled = enabled) { Text(label, fontSize = 18.sp) }
            } else {
                OutlinedButton(onClick, Modifier.fillMaxWidth().height(52.dp), enabled = enabled, colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.text)) {
                    Text(label, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        val hint = when (d.kind) {
            "clarification" -> "Responde en voz alta: se lo paso tal cual a Claude."
            "branch" -> "Di el nombre de la rama o su número."
            else -> "Responde «sí», «no» o el número."
        }
        Text(hint, color = Palette.muted, fontSize = 14.sp)
    }
}

/**
 * Como el desplegable de ramas de Slack: al abrirse muestra develop, main y
 * las release primero; al escribir filtra entre todas las ramas del remoto.
 * También se puede usar tal cual lo escrito (el servidor valida que exista).
 */
@Composable
private fun BranchPicker(d: VoiceDecision, state: UiState, enabled: Boolean) {
    var query by remember(d.jobId) { mutableStateOf("") }
    val focus = LocalFocusManager.current
    LaunchedEffect(d.jobId, query) { Dabot.actions.tryEmit(Action.SearchBranches(query.trim())) }
    val choose = { branch: String ->
        focus.clearFocus()
        Dabot.actions.tryEmit(Action.Decide(d.jobId, "branch:$branch"))
        Unit
    }

    OutlinedTextField(
        value = query,
        onValueChange = { query = it },
        singleLine = true,
        enabled = enabled,
        label = { Text("Buscar rama") },
        placeholder = { Text("develop, release/9.5, epic/…") },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onDone = {
            val q = query.trim()
            val pick = state.branchResults.firstOrNull { it.equals(q, ignoreCase = true) } ?: state.branchResults.singleOrNull() ?: q
            if (pick.isNotEmpty()) choose(pick)
        }),
        modifier = Modifier
            .fillMaxWidth()
            // Escribir en vez de hablar: DABOT deja de escuchar para no mezclar las dos cosas.
            .onFocusChanged { if (it.isFocused) Dabot.actions.tryEmit(Action.StopTalking) },
    )

    state.branchError?.let { Text(it, color = Palette.bad, fontSize = 14.sp) }
    if (state.branchLoading && state.branchResults.isEmpty() && state.branchError == null) {
        Text("Cargando ramas del remoto…", color = Palette.muted, fontSize = 14.sp)
    }

    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 340.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Palette.bg)
            .verticalScroll(rememberScrollState()),
    ) {
        val q = query.trim()
        if (q.isNotEmpty() && state.branchResults.none { it.equals(q, ignoreCase = true) }) {
            BranchRow("Usar «$q»", muted = true, enabled = enabled) { choose(q) }
        }
        state.branchResults.forEachIndexed { i, b ->
            BranchRow(if (i < 6 && q.isEmpty()) "${i + 1} · $b" else b, muted = false, enabled = enabled) { choose(b) }
        }
        if (!state.branchLoading && state.branchError == null && state.branchResults.isEmpty() && q.isNotEmpty()) {
            Text("Ninguna rama contiene «$q».", color = Palette.muted, fontSize = 14.sp, modifier = Modifier.padding(12.dp))
        }
    }
    Text("Escribe para filtrar y toca la rama, o dila en voz alta (nombre o número).", color = Palette.muted, fontSize = 14.sp)
}

@Composable
private fun BranchRow(label: String, muted: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (muted) Palette.listening else Palette.text,
        fontSize = 17.sp,
        fontFamily = if (muted) FontFamily.Default else FontFamily.Monospace,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    )
}

@Composable
private fun JobRow(job: VoiceJob) {
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(job.ticketKey, color = Palette.text, fontFamily = FontFamily.Monospace, fontSize = 15.sp, modifier = Modifier.padding(end = 10.dp))
        Text(job.summary ?: "", color = Palette.muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(job.statusLabel, color = Palette.muted, fontSize = 13.sp, modifier = Modifier.padding(start = 8.dp))
    }
}

@Composable
private fun Labeled(label: String, content: @Composable ColumnScope.() -> Unit) {
    Column {
        Text(label.uppercase(), color = Palette.muted, fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(bottom = 6.dp))
        content()
    }
}
