package com.dabot.assistant.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dabot.assistant.Action
import com.dabot.assistant.Dabot
import com.dabot.assistant.Settings

@Composable
fun SettingsDialog(
    settings: Settings,
    autostartGranted: () -> Boolean,
    requestAutostart: () -> Unit,
    batteryExempt: () -> Boolean,
    requestBatteryExemption: () -> Unit,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
) {
    var url by remember { mutableStateOf(settings.serverUrl) }
    var token by remember { mutableStateOf(settings.token) }
    var language by remember { mutableStateOf(settings.language) }
    var wake by remember { mutableStateOf(settings.wakeEnabled) }
    var wide by remember { mutableStateOf(settings.wakeWide) }
    var dim by remember { mutableStateOf(settings.dimMinutes.toString()) }
    var rate by remember { mutableFloatStateOf(settings.speechRate) }
    val validUrl = url.trim().startsWith("http://") || url.trim().startsWith("https://")

    fun persist() {
        settings.serverUrl = url
        settings.token = token
        settings.language = language
        settings.wakeEnabled = wake
        settings.wakeWide = wide
        settings.dimMinutes = dim.toIntOrNull() ?: settings.dimMinutes
        settings.speechRate = rate
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Ajustes de DABOT") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                OutlinedTextField(
                    value = url, onValueChange = { url = it }, singleLine = true,
                    label = { Text("Servidor de Bugs Manager") },
                    placeholder = { Text("http://mi-mac.mi-tailnet.ts.net:3000") },
                    supportingText = { Text("La misma URL del dashboard, vista desde la tablet (IP de tu red o nombre de Tailscale).") },
                    isError = url.isNotBlank() && !validUrl,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = token, onValueChange = { token = it }, singleLine = true,
                    label = { Text("Token (VOICE_TOKEN)") },
                    supportingText = { Text("Vacío si no lo definiste en el .env del servidor.") },
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("Idioma de voz", fontSize = 14.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("es-ES" to "España", "es-MX" to "México", "es-US" to "EE. UU.").forEach { (tag, name) ->
                        FilterChip(selected = language == tag, onClick = { language = tag }, label = { Text(name) })
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Escuchar «Dabot»")
                        Text("Sin esto, solo se habla tocando la cara.", fontSize = 13.sp, color = Palette.muted)
                    }
                    Switch(checked = wake, onCheckedChange = { wake = it })
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Detección amplia")
                        Text("Si no reacciona a tu «Dabot»: basta con que oiga «bot». Más sensible, pero con más falsas alarmas.", fontSize = 13.sp, color = Palette.muted)
                    }
                    Switch(checked = wide, onCheckedChange = { wide = it }, enabled = wake)
                }
                OutlinedTextField(
                    value = dim, onValueChange = { dim = it.filter(Char::isDigit).take(3) }, singleLine = true,
                    label = { Text("Atenuar pantalla tras (minutos, 0 = nunca)") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("Velocidad de la voz: ${"%.2f".format(rate)}", fontSize = 14.sp)
                Slider(value = rate, onValueChange = { rate = it }, valueRange = 0.7f..1.5f)
                OutlinedButton(onClick = {
                    persist()
                    Dabot.actions.tryEmit(Action.SettingsChanged)
                    Dabot.actions.tryEmit(Action.Test("Hola, soy DABOT. ¿Qué ticket arreglo?"))
                }) { Text("Probar voz") }

                Text("Siempre activo", fontSize = 14.sp, modifier = Modifier.padding(top = 6.dp))
                val autostart = autostartGranted()
                OutlinedButton(onClick = requestAutostart, enabled = !autostart, modifier = Modifier.fillMaxWidth()) {
                    Text(if (autostart) "✓ Se abre solo al encender la tablet" else "Abrir solo al encender (permitir «Aparecer encima»)")
                }
                val battery = batteryExempt()
                OutlinedButton(onClick = requestBatteryExemption, enabled = !battery, modifier = Modifier.fillMaxWidth()) {
                    Text(if (battery) "✓ Sin restricciones de batería" else "Quitar restricciones de batería")
                }
            }
        },
        confirmButton = {
            Button(enabled = validUrl, onClick = {
                persist()
                onSave()
            }) { Text("Guardar") }
        },
        dismissButton = {
            if (settings.configured) TextButton(onClick = onDismiss) { Text("Cancelar") }
        },
    )
}
