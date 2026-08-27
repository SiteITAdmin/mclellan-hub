package scot.mclellan.boox

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.onyx.android.sdk.data.note.TouchPoint
import com.onyx.android.sdk.pen.RawInputCallback
import com.onyx.android.sdk.pen.TouchHelper
import com.onyx.android.sdk.pen.data.TouchPointList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import scot.mclellan.boox.databinding.ActivityNoteBinding
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * A handwritten note page, captured with the Onyx raw-pen surface for a
 * paper-like feel on e-ink. Recognition never happens here: the finished page
 * is rasterised to a PNG and queued for upload to the hub's note door, and the
 * hub OCRs it. The page carries its planner provenance (which day/event it was
 * opened from) so the hub can file it against the right context.
 *
 * We keep our own screen-sized bitmap in step with the strokes because the raw
 * drawing renders to the e-ink controller but does not hand back an image — the
 * bitmap is what we export.
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
    private var touchHelper: TouchHelper? = null

    private var bitmap: Bitmap? = null
    private var canvas: Canvas? = null
    private val paint = Paint().apply {
        isAntiAlias = true
        color = Color.BLACK
        strokeWidth = 3f
        style = Paint.Style.STROKE
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }
    private val surfaceLoc = IntArray(2)
    private var saving = false

    private val rawCallback = object : RawInputCallback() {
        override fun onBeginRawDrawing(b: Boolean, p: TouchPoint) {}
        override fun onEndRawDrawing(b: Boolean, p: TouchPoint) {}
        override fun onRawDrawingTouchPointMoveReceived(p: TouchPoint) {}
        override fun onRawDrawingTouchPointListReceived(list: TouchPointList) = drawStroke(list)
        override fun onBeginRawErasing(b: Boolean, p: TouchPoint) {}
        override fun onEndRawErasing(b: Boolean, p: TouchPoint) {}
        override fun onRawErasingTouchPointMoveReceived(p: TouchPoint) {}
        override fun onRawErasingTouchPointListReceived(list: TouchPointList) {}
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityNoteBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = SyncRepository(this)

        val linkedDate = intent.getStringExtra(EXTRA_LINKED_DATE)
        binding.noteTitle.text = intent.getStringExtra(EXTRA_TITLE)
            ?: linkedDate?.let { "Note · $it" } ?: "Note"

        binding.btnClose.setOnClickListener { finish() }
        binding.btnClear.setOnClickListener { clear() }
        binding.btnSave.setOnClickListener { save() }

        binding.surface.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                initDrawing()
                clearSurface()
            }

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
            override fun surfaceDestroyed(holder: SurfaceHolder) {
                touchHelper?.setRawDrawingEnabled(false)
            }
        })
    }

    private fun initDrawing() {
        val surface: SurfaceView = binding.surface
        if (bitmap == null) {
            bitmap = Bitmap.createBitmap(surface.width, surface.height, Bitmap.Config.ARGB_8888)
                .also { it.eraseColor(Color.WHITE) }
            canvas = Canvas(bitmap!!)
        }
        surface.getLocationOnScreen(surfaceLoc)

        val limit = Rect(0, 0, surface.width, surface.height)
        val exclude = ArrayList<Rect>()
        binding.toolbar.let { tb ->
            val loc = IntArray(2)
            tb.getLocationOnScreen(loc)
            // Toolbar rect in the surface's own coordinate space.
            val left = loc[0] - surfaceLoc[0]
            val top = loc[1] - surfaceLoc[1]
            exclude.add(Rect(left, top, left + tb.width, top + tb.height))
        }

        touchHelper?.closeRawDrawing()
        touchHelper = TouchHelper.create(surface, rawCallback).apply {
            setStrokeStyle(TouchHelper.STROKE_STYLE_PENCIL)
            setStrokeWidth(3f)
            setLimitRect(limit, exclude)
            openRawDrawing()
            setRawDrawingEnabled(true)
        }
    }

    private fun drawStroke(list: TouchPointList) {
        val c = canvas ?: return
        val points = list.points ?: return
        if (points.isEmpty()) return
        val path = Path()
        points.forEachIndexed { i, tp ->
            val x = tp.x - surfaceLoc[0]
            val y = tp.y - surfaceLoc[1]
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        c.drawPath(path, paint)
    }

    private fun clear() {
        bitmap?.eraseColor(Color.WHITE)
        touchHelper?.setRawDrawingEnabled(false)
        clearSurface()
        touchHelper?.setRawDrawingEnabled(true)
    }

    /** Blank the visible surface to white (used on first show and on Clear). */
    private fun clearSurface() {
        val holder = binding.surface.holder
        val c = holder.lockCanvas() ?: return
        try {
            c.drawColor(Color.WHITE)
        } finally {
            holder.unlockCanvasAndPost(c)
        }
    }

    private fun save() {
        if (saving) return
        saving = true
        touchHelper?.setRawDrawingEnabled(false)
        val bmp = bitmap
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

    override fun onResume() {
        super.onResume()
        if (touchHelper != null) touchHelper?.setRawDrawingEnabled(true)
    }

    override fun onPause() {
        super.onPause()
        touchHelper?.setRawDrawingEnabled(false)
    }

    override fun onDestroy() {
        super.onDestroy()
        touchHelper?.closeRawDrawing()
        touchHelper = null
    }
}
