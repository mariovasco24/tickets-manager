package com.dabot.assistant.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.sp
import com.dabot.assistant.Mode
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/** Color de la cara por estado (también lo usa la pantalla para acentos). */
fun faceColor(mode: Mode, connected: Boolean, sleeping: Boolean): Color = when {
    !connected && mode != Mode.SPEAKING -> Palette.offline
    sleeping -> Palette.idle.copy(alpha = 0.45f)
    mode == Mode.LISTENING -> Palette.listening
    mode == Mode.THINKING -> Palette.thinking
    mode == Mode.SPEAKING -> Palette.speaking
    else -> Palette.idle
}

/**
 * La cara de DABOT: ojos LED que parpadean y miran alrededor en reposo, te
 * miran cuando escuchan (con un anillo que sigue tu voz), miran arriba cuando
 * piensan, y una boca que se mueve con cada palabra que dice.
 */
@Composable
fun Face(
    mode: Mode,
    connected: Boolean,
    sleeping: Boolean,
    micLevel: Float,
    wordTick: Int,
    modifier: Modifier = Modifier,
) {
    val color by animateColorAsState(faceColor(mode, connected, sleeping), tween(350), label = "color")
    val openness by animateFloatAsState(
        when {
            sleeping -> 0.07f
            !connected && mode == Mode.IDLE -> 0.62f
            mode == Mode.LISTENING -> 1.12f
            mode == Mode.THINKING -> 0.5f
            else -> 1f
        },
        spring(dampingRatio = 0.55f, stiffness = Spring.StiffnessMediumLow), label = "open",
    )
    val widthScale by animateFloatAsState(if (mode == Mode.LISTENING) 1.08f else 1f, spring(0.5f), label = "width")
    val mic by animateFloatAsState(micLevel, tween(90), label = "mic")

    // Parpadeo aleatorio (a veces doble), no mientras duerme.
    val blink = remember { Animatable(0f) }
    LaunchedEffect(sleeping) {
        if (sleeping) return@LaunchedEffect
        while (true) {
            delay(Random.nextLong(2_400, 6_500))
            repeat(if (Random.nextFloat() < 0.18f) 2 else 1) {
                blink.animateTo(1f, tween(70))
                blink.animateTo(0f, tween(120))
            }
        }
    }

    // Mirada: vaga en reposo, al frente escuchando/hablando, arriba a la derecha pensando.
    val gazeX = remember { Animatable(0f) }
    val gazeY = remember { Animatable(0f) }
    LaunchedEffect(mode, sleeping) {
        val look = spring<Float>(dampingRatio = 0.7f, stiffness = Spring.StiffnessLow)
        when {
            mode == Mode.THINKING -> {
                launch { gazeX.animateTo(0.55f, look) }
                gazeY.animateTo(-0.6f, look)
            }
            mode == Mode.IDLE && !sleeping -> while (true) {
                delay(Random.nextLong(1_400, 4_200))
                val x = if (Random.nextFloat() < 0.35f) 0f else Random.nextFloat() * 1.3f - 0.65f
                val y = if (Random.nextFloat() < 0.5f) 0f else Random.nextFloat() * 0.6f - 0.3f
                launch { gazeX.animateTo(x, spring(0.8f, Spring.StiffnessMedium)) }
                gazeY.animateTo(y, spring(0.8f, Spring.StiffnessMedium))
            }
            else -> {
                launch { gazeX.animateTo(0f, look) }
                gazeY.animateTo(0f, look)
            }
        }
    }

    // Boca: cada palabra (onRangeStart de la síntesis) la abre; un vaivén de fondo cubre motores sin ese evento.
    val word = remember { Animatable(0f) }
    LaunchedEffect(wordTick) {
        if (mode != Mode.SPEAKING) return@LaunchedEffect
        word.snapTo(1f)
        word.animateTo(0.15f, tween(260, easing = FastOutSlowInEasing))
    }
    val loop = rememberInfiniteTransition(label = "loop")
    val talk by loop.animateFloat(0f, 1f, infiniteRepeatable(tween(280, easing = LinearEasing), RepeatMode.Reverse), label = "talk")
    val phase by loop.animateFloat(0f, 1f, infiniteRepeatable(tween(1_100, easing = LinearEasing)), label = "phase")
    val breathe by loop.animateFloat(0f, 1f, infiniteRepeatable(tween(3_200, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "breathe")
    val mouthOpen by animateFloatAsState(
        if (mode == Mode.SPEAKING) max(word.value, 0.25f + 0.35f * talk) else 0f,
        tween(70), label = "mouth",
    )

    val zText = rememberTextMeasurer()

    Canvas(modifier) {
        val s = min(size.width, size.height) * 0.92f
        val c = Offset(size.width / 2f, size.height / 2f + s * 0.02f * (breathe - 0.5f))

        // Anillo que sigue tu voz mientras escucha.
        if (mode == Mode.LISTENING) {
            val r = s * 0.47f * (1f + 0.07f * mic)
            drawCircle(color.copy(alpha = 0.12f + 0.4f * mic), r, c, style = Stroke(width = s * (0.01f + 0.012f * mic)))
            drawCircle(color.copy(alpha = 0.06f), r * 1.06f, c, style = Stroke(width = s * 0.006f))
        }

        // Ojos.
        val eyeW = s * 0.17f * widthScale
        val eyeH = max(s * 0.3f * openness * (1f - 0.92f * blink.value), s * 0.018f)
        val gap = s * 0.175f
        val eyeY = c.y - s * 0.08f + gazeY.value * s * 0.05f
        val shiftX = gazeX.value * s * 0.06f
        for (side in listOf(-1f, 1f)) {
            glowRect(color, Offset(c.x + side * gap + shiftX, eyeY), Size(eyeW, eyeH))
        }

        // Boca.
        val mouthY = c.y + s * 0.22f
        val mouthW = s * 0.2f
        when {
            mode == Mode.SPEAKING -> glowRect(color, Offset(c.x + shiftX * 0.5f, mouthY), Size(mouthW * (0.75f + 0.15f * mouthOpen), s * (0.025f + 0.1f * mouthOpen)))
            mode == Mode.LISTENING -> {
                val r = s * (0.028f + 0.035f * mic)
                drawCircle(color.copy(alpha = 0.18f), r * 1.6f, Offset(c.x, mouthY))
                drawCircle(color, r, Offset(c.x, mouthY), style = Stroke(width = s * 0.014f))
            }
            mode == Mode.THINKING -> for (i in 0..2) {
                val t = ((phase + i * 0.18f) % 1f)
                val lift = sin(t * PI).toFloat()
                drawCircle(color, s * 0.017f, Offset(c.x + (i - 1) * s * 0.06f, mouthY - lift * s * 0.035f))
            }
            sleeping || !connected -> drawLine(color, Offset(c.x - mouthW * 0.3f, mouthY), Offset(c.x + mouthW * 0.3f, mouthY), s * 0.014f, StrokeCap.Round)
            else -> drawArc(
                color = color,
                startAngle = 20f, sweepAngle = 140f, useCenter = false,
                topLeft = Offset(c.x - mouthW / 2f, mouthY - s * 0.09f),
                size = Size(mouthW, s * 0.12f),
                style = Stroke(width = s * 0.016f, cap = StrokeCap.Round),
            )
        }

        if (sleeping) {
            val style = TextStyle(color = color, fontSize = (s * 0.045f / density).sp, fontWeight = FontWeight.Bold)
            drawText(zText, "z", Offset(c.x + gap + eyeW, eyeY - s * 0.2f - phase * s * 0.03f), style)
            drawText(zText, "z", Offset(c.x + gap + eyeW * 1.6f, eyeY - s * 0.27f - phase * s * 0.03f), style.copy(fontSize = (s * 0.032f / density).sp))
        }
    }
}

/** Rectángulo redondeado con halo, centrado en `center`. */
private fun DrawScope.glowRect(color: Color, center: Offset, size: Size) {
    val radius = min(size.width, size.height) * 0.45f
    for ((grow, alpha) in listOf(1.5f to 0.06f, 1.25f to 0.12f)) {
        val g = Size(size.width + radius * grow, size.height + radius * grow)
        drawRoundRect(color.copy(alpha = color.alpha * alpha), Offset(center.x - g.width / 2f, center.y - g.height / 2f), g, CornerRadius(radius * (1f + grow / 2f)))
    }
    drawRoundRect(color, Offset(center.x - size.width / 2f, center.y - size.height / 2f), size, CornerRadius(radius))
}
