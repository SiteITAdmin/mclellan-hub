package scot.mclellan.boox

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView

/**
 * E-ink-first view helpers, declared top-level so any view file in this package
 * can use them without ceremony. Everything is pure black ink on white with a
 * light grey rule — the Boox has no usable colour and a slow refresh, so meaning
 * is carried by weight, size, and text markers, never hue. Views are built
 * programmatically because the planner is entirely data-driven.
 */

val INK = Color.BLACK
val MUTED = Color.parseColor("#555555")
val LINE = Color.parseColor("#BFBFBF")
val FILL = Color.parseColor("#ECECEC")
val FILL_DARK = Color.parseColor("#D8D8D8")

const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

fun Context.dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

fun Context.text(
    s: CharSequence,
    size: Float = 16f,
    bold: Boolean = false,
    color: Int = INK,
): TextView = TextView(this).apply {
    text = s
    setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
    setTextColor(color)
    if (bold) setTypeface(typeface, Typeface.BOLD)
    setLineSpacing(dp(2).toFloat(), 1f)
}

fun Context.rule(marginV: Int = 0): View = View(this).apply {
    layoutParams = LinearLayout.LayoutParams(MATCH, dp(1)).also {
        it.topMargin = dp(marginV); it.bottomMargin = dp(marginV)
    }
    setBackgroundColor(LINE)
}

fun Context.sectionHeader(title: String, count: Int? = null): TextView =
    text(
        if (count == null) title.uppercase() else "${title.uppercase()}  ·  $count",
        13f, bold = true, color = MUTED,
    ).apply {
        setPadding(0, dp(18), 0, dp(6))
        letterSpacing = 0.08f
    }

/** A card with a hairline border and padding, used for a single item row. */
fun Context.card(pad: Int = 12): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(dp(pad), dp(pad), dp(pad), dp(pad))
    background = GradientDrawable().apply {
        setColor(Color.WHITE)
        setStroke(dp(1), LINE)
        cornerRadius = dp(6).toFloat()
    }
    layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).also { it.bottomMargin = dp(8) }
}
