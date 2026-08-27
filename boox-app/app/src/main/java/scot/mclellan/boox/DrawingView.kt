package scot.mclellan.boox

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import com.onyx.android.sdk.api.device.epd.EpdController
import com.onyx.android.sdk.api.device.epd.UpdateMode
import kotlin.math.max
import kotlin.math.min

/**
 * A stylus drawing surface using Android's normal MotionEvent path (the Onyx
 * raw-pen SDK's region mapping is broken on this Note Max firmware). To make it
 * feel like writing rather than the sluggish default e-ink refresh, each stroke
 * segment repaints only its own small bounding box in fast DU (direct-update)
 * mode via the Onyx device SDK — partial-region DU refresh is what makes pen
 * strokes appear immediately. A full clean refresh happens on clear. If the
 * device SDK is unavailable (non-Onyx), it falls back to plain invalidation.
 *
 * The backing bitmap is the export; the hub OCRs it — nothing is recognised here.
 */
class DrawingView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private var bitmap: Bitmap? = null
    private var bmpCanvas: Canvas? = null
    private val path = Path()
    private val paint = Paint().apply {
        isAntiAlias = true
        color = Color.BLACK
        style = Paint.Style.STROKE
        strokeWidth = 3f
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }
    private var lastX = 0f
    private var lastY = 0f
    private val pad = 6 // px around a segment so the round cap isn't clipped

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        // Make this view's normal invalidations refresh the panel in fast DU
        // (direct-update) mode. Crucially we still call the standard invalidate()
        // so onDraw runs and paints the stroke; DU only changes HOW the panel
        // refreshes, making it feel like writing. No-op off Onyx hardware.
        try {
            EpdController.setViewDefaultUpdateMode(this, UpdateMode.DU)
        } catch (_: Throwable) { /* not an Onyx device */ }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w <= 0 || h <= 0) return
        val fresh = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { it.eraseColor(Color.WHITE) }
        bitmap?.let { Canvas(fresh).drawBitmap(it, 0f, 0f, null) } // preserve on resize
        bitmap = fresh
        bmpCanvas = Canvas(fresh)
    }

    override fun onDraw(canvas: Canvas) {
        bitmap?.let { canvas.drawBitmap(it, 0f, 0f, null) }
        canvas.drawPath(path, paint)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        // Palm rejection: ignore finger touches; accept stylus/eraser/mouse.
        if (event.getToolType(0) == MotionEvent.TOOL_TYPE_FINGER) return false
        val x = event.x
        val y = event.y
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                path.moveTo(x, y)
                lastX = x; lastY = y
                fastInvalidate(x, y, x, y)
            }
            MotionEvent.ACTION_MOVE -> {
                var minX = min(lastX, x); var minY = min(lastY, y)
                var maxX = max(lastX, x); var maxY = max(lastY, y)
                for (i in 0 until event.historySize) {
                    val hx = event.getHistoricalX(i); val hy = event.getHistoricalY(i)
                    path.lineTo(hx, hy)
                    minX = min(minX, hx); minY = min(minY, hy)
                    maxX = max(maxX, hx); maxY = max(maxY, hy)
                }
                path.lineTo(x, y)
                lastX = x; lastY = y
                fastInvalidate(minX, minY, maxX, maxY)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                path.lineTo(x, y)
                bmpCanvas?.drawPath(path, paint) // commit the finished stroke
                path.reset()
                fastInvalidate(min(lastX, x), min(lastY, y), max(lastX, x), max(lastY, y))
            }
            else -> return false
        }
        return true
    }

    /** Redraw just the segment's box. onDraw runs (painting the stroke); the
     *  view's DU default update mode makes the panel refresh fast. */
    private fun fastInvalidate(x0: Float, y0: Float, x1: Float, y1: Float) {
        val l = (min(x0, x1) - pad).toInt().coerceAtLeast(0)
        val t = (min(y0, y1) - pad).toInt().coerceAtLeast(0)
        val r = (max(x0, x1) + pad).toInt().coerceAtMost(width)
        val b = (max(y0, y1) + pad).toInt().coerceAtMost(height)
        @Suppress("DEPRECATION")
        invalidate(l, t, r, b)
    }

    fun clearCanvas() {
        bitmap?.eraseColor(Color.WHITE)
        path.reset()
        // One clean full-quality (GC) refresh to wipe any DU ghosting, then the
        // view returns to DU for the next strokes.
        try {
            EpdController.setViewDefaultUpdateMode(this, UpdateMode.GC)
            invalidate()
            EpdController.setViewDefaultUpdateMode(this, UpdateMode.DU)
        } catch (_: Throwable) {
            invalidate()
        }
    }

    fun exportBitmap(): Bitmap? = bitmap
}
