package scot.mclellan.boox

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneId
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var store: HubStore
    private lateinit var root: LinearLayout
    private lateinit var content: LinearLayout
    private lateinit var status: TextView
    private val main = Handler(Looper.getMainLooper())
    private val network = Executors.newSingleThreadExecutor()
    private var data: JSONObject? = null
    private var selected = today()
    private var section = "Calendar"
    private var space = "work"
    private var syncing = false
    private var started = false
    private var opening = false
    private var message = ""
    private val refresh = object : Runnable {
        override fun run() { sync(); main.postDelayed(this, 10 * 60 * 1000L) }
    }
    private fun today() = LocalDate.now(ZoneId.of("Europe/Dublin")).toString()
    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private fun JSONArray.objects() = (0 until length()).mapNotNull { optJSONObject(it) }
    private fun JSONArray.strings() = (0 until length()).map { optString(it) }.filter { it.isNotBlank() }
    private fun JSONObject.array(key: String) = optJSONArray(key) ?: JSONArray()
    private fun label(s: String) = if (s == "work") "Work" else "Personal"

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        store = HubStore(this)
        data = store.cached()
        selected = state?.getString("selected") ?: today()
        section = state?.getString("section") ?: "Calendar"
        space = state?.getString("space") ?: "work"
        intent.data?.takeIf { it.scheme == "mclellanhub" && it.host == "day" }?.let { uri ->
            runCatching { LocalDate.parse(uri.getQueryParameter("date")) }.getOrNull()?.let { selected = it.toString() }
        }
        render()
    }
    override fun onSaveInstanceState(out: Bundle) {
        out.putString("selected", selected); out.putString("section", section); out.putString("space", space)
        super.onSaveInstanceState(out)
    }
    override fun onResume() {
        super.onResume(); started = true; opening = false
        store.launch()?.let { receipt ->
            try {
                val title = "${receipt.getString("date")} ${label(receipt.getString("space"))}"
                if (NativeNotes.find(this, title) != null) store.queue(receipt)
                store.launch(null)
            } catch (e: Exception) { message = "Could not confirm the notebook was saved. ${e.message}" }
        }
        main.post(refresh)
    }
    override fun onPause() { started = false; main.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() { main.removeCallbacksAndMessages(null); network.shutdownNow(); super.onDestroy() }

    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL }
    private fun text(value: String, size: Int = 18, bold: Boolean = false) = TextView(this).apply {
        text = value; textSize = size.toFloat(); setTextColor(Color.BLACK)
        setLineSpacing(dp(4).toFloat(), 1f)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(7), 0, dp(7))
    }
    private fun button(value: String, active: Boolean = false, action: () -> Unit) = Button(this).apply {
        text = value; textSize = 17f; isAllCaps = false; minHeight = dp(54)
        setTextColor(if (active) Color.WHITE else Color.BLACK)
        background = GradientDrawable().apply {
            setColor(if (active) Color.BLACK else Color.WHITE); setStroke(dp(1), Color.BLACK); cornerRadius = dp(5).toFloat()
        }
        setPadding(dp(12), dp(8), dp(12), dp(8))
        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { setMargins(dp(3), dp(4), dp(3), dp(4)) }
        setOnClickListener { action() }
    }
    private fun rule(parent: LinearLayout) { parent.addView(View(this).apply { setBackgroundColor(Color.BLACK) }, LinearLayout.LayoutParams(-1, dp(1)).apply { setMargins(0, dp(13), 0, dp(10)) }) }
    private fun heading(value: String) { content.addView(text(value, 24, true)) }
    private fun lines(parent: LinearLayout, values: List<String>, empty: String? = null) {
        if (values.isEmpty() && empty != null) parent.addView(text(empty))
        values.forEach { parent.addView(text(it)) }
    }
    private fun stamp(t: Long): String = if (t <= 0) "not yet" else DateTimeFormatter.ofPattern("d MMM, HH:mm").withZone(ZoneId.of("Europe/Dublin")).format(Instant.ofEpochSecond(t))
    private fun updateStatus() {
        val cachedAt = data?.optLong("serverTime") ?: 0
        status.text = listOf(if (syncing) "Syncing…" else message, "Saved on tablet: ${stamp(cachedAt)}", "Calendar checked: ${stamp(data?.optLong("calendarSyncedAt") ?: 0)}",
            if (store.pendingCount() > 0) "${store.pendingCount()} note reports waiting to sync" else "",
            (data?.optLong("readerRetryAt") ?: 0).let { if (it > System.currentTimeMillis() / 1000) "Handwriting reader is busy; automatic retry after ${stamp(it)}" else "" }).filter { it.isNotBlank() }.joinToString("\n")
    }
    private fun render() {
        root = column().apply { setPadding(dp(22), dp(14), dp(22), dp(12)); setBackgroundColor(Color.WHITE) }
        setContentView(root)
        val top = row()
        top.addView(text("McLellan Hub", 25, true), LinearLayout.LayoutParams(0, -2, 2f))
        top.addView(button("Sync") { sync() }); top.addView(button("Settings") { settings() }); root.addView(top)
        status = text("", 14); root.addView(status); updateStatus()
        val nav = row()
        listOf("Calendar", "CRM", "People").forEach { name -> nav.addView(button(name, section == name) { section = name; render() }) }; root.addView(nav)
        val scroll = ScrollView(this).apply { isFillViewport = true }
        content = column(); scroll.addView(content); root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        if (store.token().isBlank()) { heading("Connect your Boox"); content.addView(text("Open Settings to connect to your Hub. Your calendar and CRM details will then be saved here for offline reading.")) }
        when (section) { "Calendar" -> calendar(); "CRM" -> crm(); else -> people() }
    }
    private fun calendar() {
        val date = LocalDate.parse(selected)
        heading(date.format(DateTimeFormatter.ofPattern("EEEE, d MMMM")))
        val dates = row()
        dates.addView(button("Previous day") { selected = date.minusDays(1).toString(); render() })
        dates.addView(button("Today", selected == today()) { selected = today(); render() })
        dates.addView(button("Next day") { selected = date.plusDays(1).toString(); render() }); content.addView(dates)
        val day = data?.array("days")?.objects()?.find { it.optString("date") == selected }
        val notes = row()
        for (s in listOf("work", "personal")) {
            val note = day?.optJSONObject("notes")?.optJSONObject(s)
            val opened = (note != null && !note.isNull("opened")) || (note?.optInt("pages") ?: 0) > 0
            notes.addView(button("${if (opened) "Open" else "New"} ${label(s)} note") { openNote(selected, s) })
        }
        content.addView(notes)
        content.addView(text("If Boox offers a template, choose one and tap Create. Write in Notes, then return here. Keep PDF sync to Google Drive enabled.", 16))
        for (s in listOf("work", "personal")) {
            val note = day?.optJSONObject("notes")?.optJSONObject(s) ?: continue
            val state = when (note.optString("state")) { "read" -> "Read by the Hub"; "check" -> "Handwriting needs checking in Hub notebooks"; "failed" -> "The Hub could not read this note; open Hub notebooks"; "reading" -> "Waiting for the Hub to read it"; else -> if (!note.isNull("opened")) "Opened; waiting for its PDF in Drive" else "No synced note" }
            content.addView(text("${label(s)}: $state", 15))
        }
        rule(content)
        if (day == null) { content.addView(text("This day is outside the saved calendar. Sync to refresh the last 7 days and next 14 days. You can still open its dated note.")); return }
        val events = day.array("allDay").objects() + day.array("items").objects()
        if (events.isEmpty()) content.addView(text("Nothing planned for this day."))
        events.forEach { event ->
            val timing = if (event.has("from")) "${event.optString("from")}–${event.optString("until")}" else "All day"
            val block = column().apply { setPadding(dp(12), dp(8), dp(12), dp(8)); background = GradientDrawable().apply { setColor(Color.WHITE); setStroke(dp(1), Color.BLACK) } }
            block.addView(text("$timing   ${label(event.optString("space"))}${if (event.optString("type") == "task") " task" else ""}", 15, true))
            block.addView(text(event.optString("title"), 21, true))
            val names = event.array("people").strings().mapNotNull { data?.optJSONObject("people")?.optJSONObject(it)?.optString("name") }
            if (names.isNotEmpty()) block.addView(text(names.joinToString(", "), 16))
            block.isClickable = true; block.isFocusable = true; block.contentDescription = "$timing ${event.optString("title")}. Open details"
            block.setOnClickListener { eventDetail(event) }
            content.addView(block, LinearLayout.LayoutParams(-1, -2).apply { setMargins(0, dp(5), 0, dp(5)) })
        }
    }
    private fun chooseSpace() {
        val r = row(); listOf("work", "personal").forEach { s -> r.addView(button(label(s), space == s) { space = s; render() }) }; content.addView(r)
    }
    private fun promises(parent: LinearLayout, title: String, list: JSONArray) {
        parent.addView(text(title, 22, true))
        if (list.length() == 0) lines(parent, emptyList(), "Nothing outstanding.")
        list.objects().forEach { p ->
            val value = listOf(p.optString("text") + if (p.optString("to").isNotBlank()) " — ${p.optString("to")}" else "", p.optString("when")).filter { it.isNotBlank() }.joinToString("\n")
            taskRow(parent, p.optString("taskId"), value)
        }
    }
    private fun crm() {
        chooseSpace(); heading("${label(space)} at a glance")
        val s = data?.optJSONObject("spaces")?.optJSONObject(space)
        if (s == null) { content.addView(text("Sync to load your CRM.")); return }
        promises(content, "You owe", s.array("owe")); rule(content)
        promises(content, "Owed to you", s.array("owed")); rule(content)
        heading("Tasks")
        val tasks = s.array("tasks").objects()
        if (tasks.isEmpty()) lines(content, emptyList(), "No other open tasks.")
        tasks.forEach { task ->
            taskRow(content, task.optString("id"), listOf(task.optString("title"),
                if (task.optString("dueLabel").isNotBlank()) "${if (task.optBoolean("overdue")) "Overdue" else "Due"}: ${task.optString("dueLabel")}" else "",
                task.optString("planned").let { if (it.isNotBlank()) "Planned: $it" else "" }).filter { it.isNotBlank() }.joinToString("\n"))
        }
        rule(content); heading("Keep in touch")
        lines(content, s.array("drifting").objects().map { "${it.optString("name")}\n${it.optInt("sinceDays")} days since contact" }, "Nobody is overdue for a catch-up.")
        rule(content); heading("Dates to remember")
        lines(content, s.array("dates").objects().map { "${it.optString("label")}\n${it.optString("text")}" }, "No dates in the next week.")
    }
    private fun people() {
        heading("People in your diary and promises")
        val people = data?.optJSONObject("people") ?: JSONObject()
        val ids = people.keys().asSequence().toList().sortedBy { people.getJSONObject(it).optString("name") }
        if (ids.isEmpty()) content.addView(text("People will appear here when they are connected to your appointments or promises."))
        ids.forEach { id ->
            val p = people.getJSONObject(id)
            val r = row(); r.addView(button("${p.optString("name")}\n${listOf(label(p.optString("space")), p.optString("role"), p.optString("org")).filter { it.isNotBlank() }.joinToString(" · ")}") { personDetail(id) }); content.addView(r)
        }
    }
    private fun dialog(title: String, body: LinearLayout) {
        body.setPadding(dp(20), dp(12), dp(20), dp(18))
        val scroll = ScrollView(this); scroll.addView(body)
        AlertDialog.Builder(this).setTitle(title).setView(scroll).setPositiveButton("Close", null).show()
    }
    private fun personDetail(id: String) {
        val p = data?.optJSONObject("people")?.optJSONObject(id) ?: return
        val body = column()
        lines(body, listOf(p.optString("role"), p.optString("org"), p.optString("lastContact").let { if (it.isBlank()) "" else "Last contact: $it" }).filter { it.isNotBlank() })
        lines(body, p.array("standing").strings(), "No written summary yet.")
        promises(body, "You owe", p.array("owe")); promises(body, "Owed to you", p.array("owed"))
        dialog(p.optString("name"), body)
    }
    private fun taskRow(parent: LinearLayout, id: String, value: String) {
        val available = data?.optJSONObject("taskDetails")?.has(id) == true
        val view = text(value + if (available) "\nTap for guidance" else "")
        if (available) {
            view.isClickable = true; view.isFocusable = true
            view.setOnClickListener { taskDetail(id, value.substringBefore("\n")) }
        }
        parent.addView(view)
    }
    private fun taskDetail(id: String, title: String) {
        val task = data?.optJSONObject("taskDetails")?.optJSONObject(id)
        val guidance = task?.optJSONObject("guidance")
        val help = guidance?.optJSONObject("help")
        val body = column()
        fun section(name: String, values: List<String>) {
            if (values.isNotEmpty()) { body.addView(text(name, 22, true)); lines(body, values) }
        }
        fun cited(line: JSONObject?) {
            if (line == null) return
            if (line.optString("text").isNotBlank()) body.addView(text(line.optString("text")))
            line.array("sources").objects().forEach { source ->
                val r = row()
                r.addView(button("Source: ${source.optString("title")}") {
                    val uri = android.net.Uri.parse("https://douglas.mclellan.scot/crm/${task?.optString("space")}/sources/${android.net.Uri.encode(source.optString("id"))}")
                    runCatching { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, uri)) }
                        .onFailure { Toast.makeText(this, "Open the source in the Hub when online.", Toast.LENGTH_LONG).show() }
                }); body.addView(r)
            }
        }
        fun citedSection(name: String, values: JSONArray) {
            if (values.length() > 0) { body.addView(text(name, 22, true)); values.objects().forEach { cited(it) } }
        }
        if ((guidance?.optLong("writtenAt", 0) ?: 0) > 0) body.addView(text("Written: ${stamp(guidance!!.optLong("writtenAt"))}", 15))
        if (guidance?.optString("state") == "failed") body.addView(text("Could not write the latest guidance. ${guidance.optString("error")}"))
        else if (guidance?.optString("state") == "waiting" || guidance?.optBoolean("outdated") == true) body.addView(text("Updated guidance is being prepared."))
        if (help == null) body.addView(text("No guidance saved yet. Sync again after the Hub has prepared it."))
        else {
            section("Help with this", listOf(help.optString("gist")).filter { it.isNotBlank() })
            val should = help.optJSONObject("should")
            body.addView(text(when (should?.optString("verdict")) { "do" -> "Worth doing"; "skip" -> "May not be needed"; else -> "Check first" }, 22, true)); cited(should)
            if (help.optJSONObject("behind")?.optString("text")?.isNotBlank() == true) { body.addView(text("What's really going on", 22, true)); cited(help.optJSONObject("behind")) }
            citedSection("Options", help.array("options"))
            section("The Hub would", listOf(help.optString("recommend")).filter { it.isNotBlank() })
            body.addView(text("This is the Hub's own reading of the context and tools. Check it before relying on it.", 15))
            citedSection("How to do it", help.array("steps"))
            body.addView(text("Steps without a source are general know-how.", 15))
            citedSection("What you already have", help.array("have"))
            section("Not in the Hub", help.array("missing").strings())
            help.optJSONObject("draft")?.let { draft ->
                section("Draft", listOf(draft.optString("to"), draft.optString("subject")).filter { it.isNotBlank() })
                body.addView(text(draft.optString("body")).apply { setTextIsSelectable(true) })
                cited(draft)
                body.addView(text("Nothing is sent for you. Square brackets mark details missing from your records.", 15))
            }
            if (help.array("with").length() > 0) body.addView(text("Part of the same job", 22, true))
            help.array("with").objects().forEach { other -> taskRow(body, other.optString("id"), other.optString("title")) }
        }
        dialog(task?.optString("title") ?: title, body)
    }
    private fun eventDetail(event: JSONObject) {
        if (event.optString("type") == "task") { taskDetail(event.optString("id"), event.optString("title")); return }
        val body = column()
        event.array("people").strings().forEach { id ->
            val p = data?.optJSONObject("people")?.optJSONObject(id)
            val r = row(); r.addView(button(p?.optString("name") ?: "Person") { personDetail(id) }); body.addView(r)
        }
        lines(body, event.array("guests").strings())
        body.addView(text("Meeting preparation", 22, true)); lines(body, event.array("prep").strings(), "No preparation saved.")
        body.addView(text("What happened", 22, true)); lines(body, event.array("happened").strings(), "No meeting notes read yet.")
        body.addView(text("Tasks", 22, true))
        if (event.array("tasks").length() == 0) lines(body, emptyList(), "No linked tasks.")
        event.array("tasks").objects().forEach { task -> taskRow(body, task.optString("id"), "${if (task.optBoolean("done")) "Done: " else ""}${task.optString("title")}") }
        promises(body, "Promises", event.array("promises"))
        dialog(event.optString("title"), body)
    }
    private fun openNote(date: String, s: String) {
        if (opening) return
        opening = true
        try {
            val created = NativeNotes.find(this, "$date ${label(s)}") == null
            store.launch(JSONObject().put("id", UUID.randomUUID().toString()).put("date", date).put("space", s).put("created", created).put("at", System.currentTimeMillis() / 1000))
            NativeNotes.open(this, "$date ${label(s)}")
        } catch (e: Exception) {
            opening = false
            store.launch(null)
            AlertDialog.Builder(this).setTitle("Could not open the daily note").setMessage(e.message ?: "Open Boox Notes once and try again.").setPositiveButton("OK", null).show()
        }
    }
    private fun sync() {
        if (syncing || store.token().isBlank()) return
        syncing = true; updateStatus()
        network.execute {
            var receiptError = ""
            runCatching { store.flush() }.onFailure { receiptError = "Note reports still waiting: ${it.message}" }
            val result = runCatching { store.request("sync?app=2.1.0").also { store.saveCache(it) } }
            main.post {
                if (isDestroyed) return@post
                syncing = false
                result.onSuccess { data = it; message = receiptError.ifBlank { "Up to date" } }
                    .onFailure { message = "${if (data == null) "Could not sync." else "Offline — showing saved details."} ${it.message ?: "Check Wi-Fi and try Sync."}" }
                if (started) render()
            }
        }
    }
    private fun settings() {
        val body = column().apply { setPadding(dp(24), dp(10), dp(24), dp(10)) }
        body.addView(text("This tablet connects to douglas.mclellan.scot. The device token stays in the app's private storage. Leave blank to keep the current connection.", 16))
        val input = EditText(this).apply { hint = "Device token"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        body.addView(input)
        AlertDialog.Builder(this).setTitle("Tablet connection").setView(body).setNegativeButton("Cancel", null)
            .setPositiveButton("Save") { _, _ ->
                if (input.text.isNotBlank()) store.token(input.text.toString())
                render(); sync()
            }.show()
    }
}
