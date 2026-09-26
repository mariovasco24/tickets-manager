package com.dabot.assistant

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings as AndroidSettings
import android.util.Log

/**
 * Abre DABOT al encender la tablet (y tras instalar una versión nueva). Android
 * solo permite abrir una Activity desde aquí si la app tiene "Aparecer encima";
 * el micrófono lo arranca después la Activity, ya en primer plano.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (!AndroidSettings.canDrawOverlays(context)) {
            Log.i("DabotBoot", "Sin permiso \"Aparecer encima\": DABOT no se abre solo")
            return
        }
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
        )
    }
}
