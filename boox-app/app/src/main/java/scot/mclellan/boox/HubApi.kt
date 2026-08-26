package scot.mclellan.boox

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The one network client. Authenticates every request with the build-time
 * bearer, exactly like the other native Hub apps, and reuses the same endpoints
 * the web UI does — the app never gets a private API.
 *
 * Returns the raw JSON body so the caller can persist it verbatim for offline
 * use; parsing is the repository's job. Timeouts are generous because the Boox
 * radio is slow and this runs off the main thread anyway.
 */
object HubApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    private fun authed(builder: Request.Builder): Request.Builder =
        builder.header("Authorization", "Bearer ${BuildConfig.HUB_BOOX_TOKEN}")

    /** Full sync payload as raw JSON text. Throws on a non-2xx or empty body. */
    suspend fun syncRaw(days: Int = 90): String = withContext(Dispatchers.IO) {
        if (BuildConfig.HUB_BOOX_TOKEN.isBlank()) {
            throw IOException("No HUB_BOOX_TOKEN baked into this build.")
        }
        val request = authed(
            Request.Builder().url("${BuildConfig.HUB_BASE_URL}/api/boox/sync?days=$days"),
        ).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("sync failed: HTTP ${response.code}")
            response.body?.string() ?: throw IOException("sync returned an empty body")
        }
    }
}
