package scot.mclellan.boox

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A non-2xx HTTP response. Carries the status so the outbox flush can drop a
 *  permanently-rejected op (4xx) but keep retrying a transient one (5xx). */
class HttpException(val code: Int, body: String) : IOException("HTTP $code: ${body.take(200)}")

/**
 * The one network client. Authenticates every request with the build-time
 * bearer, exactly like the other native Hub apps, and reuses the same endpoints
 * the web UI does — the app never gets a private API. Reads return the raw JSON
 * body so the caller can persist it verbatim for offline use; writes POST to the
 * same /api/tasks routes the web UI uses, so createTask/updateTask and the
 * effect gate remain the only task writer.
 */
object HubApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    private val JSON = "application/json; charset=utf-8".toMediaType()

    private fun authed(builder: Request.Builder): Request.Builder =
        builder.header("Authorization", "Bearer ${BuildConfig.HUB_BOOX_TOKEN}")

    private fun requireToken() {
        if (BuildConfig.HUB_BOOX_TOKEN.isBlank()) throw IOException("No HUB_BOOX_TOKEN baked into this build.")
    }

    /** Full sync payload as raw JSON text. Throws on a non-2xx or empty body. */
    suspend fun syncRaw(days: Int = 90): String = withContext(Dispatchers.IO) {
        requireToken()
        val request = authed(
            Request.Builder().url("${BuildConfig.HUB_BASE_URL}/api/boox/sync?days=$days"),
        ).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw HttpException(response.code, response.body?.string().orEmpty())
            response.body?.string() ?: throw IOException("sync returned an empty body")
        }
    }

    private suspend fun postJson(path: String, json: String): String = withContext(Dispatchers.IO) {
        requireToken()
        val request = authed(
            Request.Builder().url("${BuildConfig.HUB_BASE_URL}$path").post(json.toRequestBody(JSON)),
        ).build()
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw HttpException(response.code, text)
            text
        }
    }

    suspend fun completeTask(taskId: String): Unit {
        postJson("/api/tasks/$taskId/complete", "{}")
    }

    suspend fun rescheduleTask(taskId: String, due: String) {
        postJson("/api/tasks/$taskId/update", buildJsonObject { put("due", due) }.toString())
    }

    /**
     * Create a task with the same fields the Hub's own new-task form offers. A
     * lane opts it into the planner; no lane leaves it in the inbox, matching
     * the web form's planner_selected semantics. Priority/effort/start are
     * stored by the Hub as the Google-visible notes tags the planner reads.
     */
    suspend fun createTask(
        title: String,
        lane: String?,
        due: String?,
        priority: String? = null,
        effortMinutes: Int? = null,
        start: String? = null,
        notes: String? = null,
    ) {
        val body = buildJsonObject {
            put("title", title)
            if (lane == "work" || lane == "personal") {
                put("planner_lane", lane)
                put("planner_selected", true)
            }
            if (!due.isNullOrBlank()) put("due", due)
            if (priority in listOf("low", "medium", "high")) put("priority", priority)
            if (effortMinutes != null && effortMinutes > 0) put("effort_minutes", effortMinutes)
            if (!start.isNullOrBlank()) put("start", start)
            if (!notes.isNullOrBlank()) put("notes", notes)
        }
        postJson("/api/tasks", body.toString())
    }

    /**
     * Planner placement. Both are server-side operations over the live calendar,
     * so they are online-only — unlike task edits they are not queued offline,
     * because the result depends on calendar state at the moment they run.
     * Auto-plan places currently unscheduled tasks; reshuffle only rescues
     * blocks whose slot has already passed.
     */
    suspend fun autoPlan(startDate: String, endDate: String): String = postJson(
        "/api/planner/auto-plan",
        buildJsonObject {
            put("startDate", startDate)
            put("endDate", endDate)
        }.toString(),
    )

    suspend fun reshuffle(): String = postJson("/api/planner/reshuffle", "{}")

    /**
     * Upload one handwritten page as raw ink to the hub's note door. Idempotent
     * on captureId, so an offline retry can't double-land a page. The hub OCRs it
     * — nothing is recognised here. Provenance ties the page to a planner day/event.
     */
    suspend fun uploadNote(
        captureId: String,
        file: File,
        title: String?,
        capturedAt: String?,
        linkedDate: String?,
        linkedEventId: String?,
        pageRef: String?,
    ) = withContext(Dispatchers.IO) {
        requireToken()
        val builder = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("captureId", captureId)
            .addFormDataPart("file", "$captureId.png", file.asRequestBody("image/png".toMediaType()))
        title?.let { builder.addFormDataPart("title", it) }
        capturedAt?.let { builder.addFormDataPart("capturedAt", it) }
        linkedDate?.let { builder.addFormDataPart("linkedDate", it) }
        linkedEventId?.let { builder.addFormDataPart("linkedEventId", it) }
        pageRef?.let { builder.addFormDataPart("pageRef", it) }
        val request = authed(
            Request.Builder().url("${BuildConfig.HUB_BASE_URL}/api/boox/notes").post(builder.build()),
        ).build()
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw HttpException(response.code, text)
        }
    }
}
