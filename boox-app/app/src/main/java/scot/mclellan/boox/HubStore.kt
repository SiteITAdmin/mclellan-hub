package scot.mclellan.boox

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URL
import javax.net.ssl.HttpsURLConnection

class HubStore(context: Context) {
    private val dir = context.filesDir
    private val lock = Any()
    private fun file(name: String) = AtomicFile(File(dir, name))
    private fun read(name: String): String? = runCatching { file(name).openRead().bufferedReader().use { it.readText() } }.getOrNull()
    private fun write(name: String, value: String) {
        val f = file(name)
        val stream = f.startWrite()
        try { stream.write(value.toByteArray(Charsets.UTF_8)); f.finishWrite(stream) }
        catch (e: Exception) { f.failWrite(stream); throw e }
    }
    fun token() = synchronized(lock) { read("device-token")?.trim().orEmpty() }
    fun token(value: String) = synchronized(lock) { write("device-token", value.trim()) }
    fun cached() = synchronized(lock) { read("agenda.json")?.let { runCatching { JSONObject(it) }.getOrNull() } }
    fun saveCache(data: JSONObject) = synchronized(lock) { write("agenda.json", data.toString()) }
    fun launch(): JSONObject? = synchronized(lock) { read("note-launch.json")?.let { runCatching { JSONObject(it) }.getOrNull() } }
    fun launch(value: JSONObject?) = synchronized(lock) { write("note-launch.json", value?.toString() ?: "null") }
    private fun pending() = read("outbox.json")?.let { JSONArray(it) } ?: JSONArray()
    fun queue(receipt: JSONObject) = synchronized(lock) { write("outbox.json", pending().put(receipt).toString()) }
    fun pendingCount() = synchronized(lock) { pending().length() }
    fun flush() {
        val batch = synchronized(lock) { pending() }
        for (i in 0 until batch.length()) {
            val receipt = batch.getJSONObject(i)
            request("note", receipt)
            synchronized(lock) {
                val current = pending(); val remaining = JSONArray()
                for (j in 0 until current.length()) if (current.getJSONObject(j).getString("id") != receipt.getString("id")) remaining.put(current.get(j))
                write("outbox.json", remaining.toString())
            }
        }
    }
    fun request(path: String, body: JSONObject? = null): JSONObject {
        val secret = token()
        check(secret.isNotEmpty()) { "Connect this tablet in Settings first." }
        val connection = URL("https://douglas.mclellan.scot/api/crm/boox/$path").openConnection() as HttpsURLConnection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 15000; connection.readTimeout = 45000
        connection.setRequestProperty("Authorization", "Bearer $secret")
        connection.setRequestProperty("Accept", "application/json")
        try {
            if (body != null) {
                connection.requestMethod = "POST"; connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            if (status !in 200..299) error(when (status) {
                401, 403 -> "The tablet connection was refused. Check its token in Settings."
                503 -> "The Hub's tablet connection is not configured yet."
                else -> "The Hub could not sync (HTTP $status). Try again shortly."
            })
            val data = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            check(data.optBoolean("ok")) { "The Hub returned an incomplete response." }
            return data
        } finally { connection.disconnect() }
    }
}
