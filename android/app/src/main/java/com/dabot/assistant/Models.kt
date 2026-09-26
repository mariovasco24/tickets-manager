package com.dabot.assistant

import org.json.JSONArray
import org.json.JSONObject

/** Espejo de VoiceJob / VoiceDecision / VoiceReply de src/voice/service.ts del servidor. */
data class VoiceJob(
    val id: String,
    val ticketKey: String,
    val summary: String?,
    val status: String,
    val statusLabel: String,
    val source: String,
    val issue: String?,
    val solution: String?,
    val testsResult: String?,
    val failureReason: String?,
    val prUrls: List<String>,
    val updatedAt: Long,
) {
    val terminal: Boolean get() = status in setOf("fixed", "cannot_fix", "failed", "discarded")

    companion object {
        fun from(o: JSONObject) = VoiceJob(
            id = o.getString("id"),
            ticketKey = o.getString("ticketKey"),
            summary = o.optStringOrNull("summary"),
            status = o.getString("status"),
            statusLabel = o.optString("statusLabel", o.getString("status")),
            source = o.optString("source"),
            issue = o.optStringOrNull("issue"),
            solution = o.optStringOrNull("solution"),
            testsResult = o.optStringOrNull("testsResult"),
            failureReason = o.optStringOrNull("failureReason"),
            prUrls = o.optJSONArray("prUrls").strings(),
            updatedAt = o.optLong("updatedAt"),
        )
    }
}

data class VoiceOption(val id: String, val label: String)

data class VoiceDecision(
    val kind: String,
    val jobId: String,
    val ticketKey: String,
    val question: String,
    val options: List<VoiceOption>,
    val freeText: Boolean,
) {
    companion object {
        fun from(o: JSONObject) = VoiceDecision(
            kind = o.getString("kind"),
            jobId = o.getString("jobId"),
            ticketKey = o.getString("ticketKey"),
            question = o.optString("question"),
            options = o.optJSONArray("options").objects().map { VoiceOption(it.getString("id"), it.getString("label")) },
            freeText = o.optBoolean("freeText"),
        )
    }
}

/** Respuesta a un comando o anuncio llegado por SSE. */
data class VoiceReply(
    val say: String,
    val display: String?,
    val listen: Boolean,
    val job: VoiceJob?,
    val decision: VoiceDecision?,
    val jobId: String?,
) {
    companion object {
        fun from(o: JSONObject) = VoiceReply(
            say = o.optString("say"),
            display = o.optStringOrNull("display"),
            listen = o.optBoolean("listen"),
            job = o.optJSONObject("job")?.let(VoiceJob::from),
            decision = o.optJSONObject("decision")?.let(VoiceDecision::from),
            jobId = o.optStringOrNull("jobId"),
        )
    }
}

data class VoiceState(
    val jobs: List<VoiceJob>,
    val focusJob: VoiceJob?,
    val focusDecision: VoiceDecision?,
    val say: String,
) {
    companion object {
        fun from(o: JSONObject): VoiceState {
            val focus = o.optJSONObject("focus")
            return VoiceState(
                jobs = o.optJSONArray("jobs").objects().map(VoiceJob::from),
                focusJob = focus?.optJSONObject("job")?.let(VoiceJob::from),
                focusDecision = focus?.optJSONObject("decision")?.let(VoiceDecision::from),
                say = o.optString("say"),
            )
        }
    }
}

private fun JSONObject.optStringOrNull(name: String): String? =
    if (isNull(name) || !has(name)) null else optString(name).takeIf { it.isNotEmpty() }

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).map { getString(it) }

private fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }
