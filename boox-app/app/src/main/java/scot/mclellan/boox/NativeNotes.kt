package scot.mclellan.boox

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

object NativeNotes {
    private val uri = Uri.parse("content://com.onyx.android.sdk.note.ContentProvider/NoteModel")

    // This firmware interface is private. A failed lookup must not create a duplicate notebook.
    fun find(context: Context, title: String): String? {
        val cursor = context.contentResolver.query(uri, arrayOf("uniqueId", "title", "type"),
            "title=? AND type=1", arrayOf(title), null)
            ?: error("Boox Notes did not allow notebook lookup. Open Notes once and try again.")
        return cursor.use {
            if (it.count > 1) error("Several notebooks have this name. Open the correct one in Boox Notes.")
            if (it.moveToFirst()) it.getString(it.getColumnIndexOrThrow("uniqueId")) else null
        }
    }

    fun open(context: Context, title: String): Boolean {
        val existing = find(context, title)
        val bean = JSONObject().put("title", title).put("create", existing == null)
        if (existing != null) bean.put("documentId", existing)
        context.startActivity(Intent().setClassName("com.onyx.android.note", "com.onyx.android.note.note.ui.ScribbleActivity")
            .putExtra("OPEN_NOTE_BEAN", bean.toString()))
        return existing == null
    }
}
