package scot.mclellan.boox

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

/**
 * Bridge to the device's native Notes app (com.onyx.android.note), which owns
 * the real pen experience — eraser, pen-button tools, raw-pen feel — that the
 * Onyx pen SDK cannot give a third-party app on this firmware.
 *
 * Open-or-create: the Notes database is an exported, permission-free content
 * provider, so we can look a note up by title and reopen it instead of making a
 * second note every time. Verified on the Note Max:
 *   content://com.onyx.android.sdk.note.ContentProvider/NoteModel
 *   → columns uniqueId, title, type (1 = note, 0 = folder)
 *
 * ScribbleActivity takes an OPEN_NOTE_BEAN JSON extra (fastjson2 → OpenNoteBean).
 * `title` MUST always be present: the app saves on pause via
 * SaveDocumentAction.setTitle, which is non-null annotated, so a bean carrying
 * only a documentId crashes the Notes app when the note is closed.
 *
 * This is a private interface reverse-engineered from the shipped app, so every
 * step fails soft: if the lookup or the launch fails we fall back to creating a
 * note, and the caller falls back to in-app capture if the app is absent.
 */
object NativeNotes {
    private const val PKG = "com.onyx.android.note"
    private const val SCRIBBLE = "com.onyx.android.note.note.ui.ScribbleActivity"
    private val NOTE_URI: Uri = Uri.parse("content://com.onyx.android.sdk.note.ContentProvider/NoteModel")

    /** uniqueId of an existing note with this exact title, or null. */
    fun findNoteId(context: Context, title: String): String? = runCatching {
        context.contentResolver.query(
            NOTE_URI,
            arrayOf("uniqueId", "title", "type"),
            "title=? AND type=1",
            arrayOf(title),
            null,
        )?.use { c ->
            if (c.moveToFirst()) c.getString(c.getColumnIndexOrThrow("uniqueId")) else null
        }
    }.getOrNull()

    /**
     * Open the note called [title], creating it if it doesn't exist yet. Returns
     * false if the Notes app could not be launched at all.
     */
    fun openOrCreate(context: Context, title: String): Boolean {
        val existingId = findNoteId(context, title)
        val bean = JSONObject().put("title", title).apply {
            if (existingId != null) put("documentId", existingId).put("create", false)
            else put("create", true)
        }
        val intent = Intent()
            .setClassName(PKG, SCRIBBLE)
            .putExtra("OPEN_NOTE_BEAN", bean.toString())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(intent); true }.getOrDefault(false)
    }
}
