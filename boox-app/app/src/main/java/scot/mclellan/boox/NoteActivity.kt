package scot.mclellan.boox

import android.graphics.Bitmap
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import scot.mclellan.boox.databinding.ActivityNoteBinding
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * A handwritten note page. The pen is captured via DrawingView (standard
 * MotionEvent path) and the finished page is rasterised to a PNG, then queued
 * for upload to the hub's note door — the hub OCRs it, nothing is recognised
 * here. The page carries its planner provenance (which day/event it was opened
 * from) so the hub can file it against the right context.
 */
class NoteActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_LINKED_DATE = "linkedDate"
        const val EXTRA_LINKED_EVENT_ID = "linkedEventId"
        const val EXTRA_PAGE_REF = "pageRef"
        const val EXTRA_TITLE = "title"
    }

    private lateinit var binding: ActivityNoteBinding
    private lateinit var repo: SyncRepository
    private var saving = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityNoteBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = SyncRepository(this)

        val linkedDate = intent.getStringExtra(EXTRA_LINKED_DATE)
        binding.noteTitle.text = intent.getStringExtra(EXTRA_TITLE)
            ?: linkedDate?.let { "Note · $it" } ?: "Note"

        binding.btnClose.setOnClickListener { finish() }
        binding.btnClear.setOnClickListener { binding.drawing.clearCanvas() }
        binding.btnSave.setOnClickListener { save() }
    }

    private fun save() {
        if (saving) return
        saving = true
        val bmp: Bitmap? = binding.drawing.exportBitmap()
        if (bmp == null) { finish(); return }

        val captureId = "boox-${UUID.randomUUID()}"
        val linkedDate = intent.getStringExtra(EXTRA_LINKED_DATE)
        val linkedEventId = intent.getStringExtra(EXTRA_LINKED_EVENT_ID)
        val pageRef = intent.getStringExtra(EXTRA_PAGE_REF)
        val title = binding.noteTitle.text?.toString()

        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    val dir = File(filesDir, "notes").apply { mkdirs() }
                    val file = File(dir, "$captureId.png")
                    FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    repo.enqueueNote(captureId, file.absolutePath, title, linkedDate, linkedEventId, pageRef)
                }.isSuccess
            }
            // A queued note flushes on the next sync; finishing returns to the planner.
            setResult(if (ok) RESULT_OK else RESULT_CANCELED)
            finish()
        }
    }
}
