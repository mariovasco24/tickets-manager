package com.dabot.assistant

import android.content.Context

/** Ajustes persistentes de la tablet. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("dabot", Context.MODE_PRIVATE)

    /** p. ej. http://mac-mini.tu-tailnet.ts.net:3000 o http://192.168.1.12:3000 */
    var serverUrl: String
        get() = prefs.getString("serverUrl", "") ?: ""
        set(v) = prefs.edit().putString("serverUrl", v.trim().trimEnd('/')).apply()

    /** VOICE_TOKEN del .env del servidor (vacío si no lo usas). */
    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) = prefs.edit().putString("token", v.trim()).apply()

    /** Idioma del reconocedor y de la voz: es-ES, es-MX, es-US… */
    var language: String
        get() = prefs.getString("language", "es-ES") ?: "es-ES"
        set(v) = prefs.edit().putString("language", v).apply()

    /** Escuchar "Dabot" continuamente. Sin esto, solo se habla tocando la cara. */
    var wakeEnabled: Boolean
        get() = prefs.getBoolean("wakeEnabled", true)
        set(v) = prefs.edit().putBoolean("wakeEnabled", v).apply()

    /** Detección amplia de "Dabot": basta con oír "bot". */
    var wakeWide: Boolean
        get() = prefs.getBoolean("wakeWide", false)
        set(v) = prefs.edit().putBoolean("wakeWide", v).apply()

    /** Minutos sin actividad antes de atenuar la pantalla (0 = nunca). */
    var dimMinutes: Int
        get() = prefs.getInt("dimMinutes", 3)
        set(v) = prefs.edit().putInt("dimMinutes", v.coerceIn(0, 120)).apply()

    var speechRate: Float
        get() = prefs.getFloat("speechRate", 1.05f)
        set(v) = prefs.edit().putFloat("speechRate", v.coerceIn(0.6f, 1.8f)).apply()

    val configured: Boolean get() = serverUrl.startsWith("http")
}
