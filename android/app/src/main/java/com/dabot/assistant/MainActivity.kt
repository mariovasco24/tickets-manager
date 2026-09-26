package com.dabot.assistant

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.dabot.assistant.ui.DabotApp

/**
 * Pantalla completa, siempre encendida, también sobre la pantalla de bloqueo.
 * Arranca el servicio en cuanto hay permiso de micrófono y lo relanza al
 * volver a primer plano (Android 14 no deja hacerlo desde segundo plano).
 */
class MainActivity : ComponentActivity() {
    private lateinit var settings: Settings

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        startDabot()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = Settings(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        hideSystemBars()

        setContent {
            DabotApp(
                settings = settings,
                onSettingsSaved = { Dabot.actions.tryEmit(Action.SettingsChanged) },
                autostartGranted = { AndroidSettings.canDrawOverlays(this) },
                requestAutostart = ::requestAutostart,
                batteryExempt = ::batteryExempt,
                requestBatteryExemption = ::requestBatteryExemption,
                setDimmed = ::setDimmed,
            )
        }
        askPermissions()
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        if (hasMic()) startDabot()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun askPermissions() {
        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) startDabot() else permissions.launch(needed.toTypedArray())
    }

    private fun hasMic() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun startDabot() {
        if (!hasMic()) {
            Dabot.update { it.copy(wakeError = "Sin permiso de micrófono: concédelo en Ajustes de Android") }
            return
        }
        ContextCompat.startForegroundService(this, Intent(this, DabotService::class.java))
    }

    private fun hideSystemBars() {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    /** Pantalla casi apagada en reposo prolongado; se despierta con cualquier actividad. */
    private fun setDimmed(dimmed: Boolean) {
        val target = if (dimmed) 0.02f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        if (window.attributes.screenBrightness == target) return
        window.attributes = window.attributes.apply { screenBrightness = target }
    }

    /** "Aparecer encima": permite que BootReceiver abra DABOT al encender la tablet. */
    private fun requestAutostart() {
        startActivity(Intent(AndroidSettings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
    }

    private fun batteryExempt(): Boolean =
        getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    @SuppressLint("BatteryLife") // es una app dedicada: debe seguir escuchando siempre
    private fun requestBatteryExemption() {
        startActivity(Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
    }
}
