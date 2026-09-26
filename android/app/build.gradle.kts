import java.net.URI
import java.util.zip.ZipFile

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.dabot.assistant"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dabot.assistant"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // Tab A8 (Unisoc T618) y cualquier tablet ARM; sin x86 el APK pesa la mitad.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    buildTypes {
        release {
            // Sin R8: Vosk usa JNA por reflexión. Firmado con la clave de debug para instalar el APK a mano.
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.09.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    // Palabra de activación offline ("Dabot"): Vosk con gramática cerrada.
    implementation("com.alphacephei:vosk-android:0.3.75@aar")
    implementation("net.java.dev.jna:jna:5.18.1@aar")
}

// ---------------------------------------------------------------------------
// Modelo de Vosk en español (40 MB): se descarga una vez a .vosk-cache y se
// empaqueta como assets/model-es con el archivo uuid que exige StorageService.
// ---------------------------------------------------------------------------
val voskModel = "vosk-model-small-es-0.42"
val voskAssets = layout.buildDirectory.dir("generated/vosk-assets")
val voskCache = rootProject.layout.projectDirectory.dir(".vosk-cache").asFile

val fetchVoskModel by tasks.registering {
    description = "Descarga y prepara el modelo de Vosk para la palabra de activación"
    val outDir = voskAssets.map { it.dir("model-es").asFile }
    val cacheDir = voskCache
    val modelName = voskModel
    outputs.dir(outDir)
    doLast {
        val dir = outDir.get()
        if (File(dir, "uuid").readTextOrNull() == modelName) return@doLast
        cacheDir.mkdirs()
        val zip = File(cacheDir, "$modelName.zip")
        if (!zip.exists()) {
            logger.lifecycle("Descargando $modelName…")
            val tmp = File(cacheDir, "$modelName.zip.part")
            URI("https://alphacephei.com/vosk/models/$modelName.zip").toURL().openStream().use { input ->
                tmp.outputStream().use { input.copyTo(it) }
            }
            tmp.renameTo(zip)
        }
        dir.deleteRecursively()
        dir.mkdirs()
        ZipFile(zip).use { z ->
            z.entries().asSequence().filter { !it.isDirectory }.forEach { e ->
                val target = File(dir, e.name.substringAfter('/'))
                target.parentFile.mkdirs()
                z.getInputStream(e).use { input -> target.outputStream().use { input.copyTo(it) } }
            }
        }
        File(dir, "uuid").writeText(modelName)
    }
}

fun File.readTextOrNull(): String? = if (exists()) readText().trim() else null

android.sourceSets["main"].assets.srcDir(voskAssets)
tasks.named("preBuild") { dependsOn(fetchVoskModel) }
