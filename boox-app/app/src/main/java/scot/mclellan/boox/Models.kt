package scot.mclellan.boox

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * The shape of GET /api/boox/sync. Only the fields the app renders are declared;
 * the JSON decoder ignores everything else (ignoreUnknownKeys), so the server
 * can add fields without breaking an already-installed build. Storing the raw
 * body offline (see SyncRepository) preserves the fields this model drops.
 *
 * The planner window uses camelCase (dayNumber, startAt, taskId); the task
 * mirror is the raw Hub row, which is snake_case (planner_lane, effective_due),
 * so those carry @SerialName. Do not "tidy" the task field names — they must
 * match the server's row keys exactly or they silently decode to defaults.
 */
@Serializable
data class SyncResponse(
    val ok: Boolean = false,
    val serverTime: Long = 0,
    val today: String = "",
    val planner: Planner = Planner(),
    val tasks: List<Task> = emptyList(),
    val notes: List<String> = emptyList(),
)

@Serializable
data class Planner(
    val startDate: String = "",
    val endDate: String = "",
    val days: List<Day> = emptyList(),
    val events: List<Event> = emptyList(),
    val unscheduledTasks: List<Task> = emptyList(),
    val preferences: Prefs = Prefs(),
)

@Serializable
data class Day(
    val date: String = "",
    val label: String = "",
    val dayNumber: Int = 0,
    val monthLabel: String = "",
)

/**
 * One occupancy block in the planner window. A genuine appointment has
 * `taskId == null` / `isTask == false`; a scheduled task block carries the
 * task's id in `taskId` (that is how the planner mirrors a task onto the
 * calendar). The two render differently so the day never looks like it has two
 * separate commitments for one task.
 */
@Serializable
data class Event(
    val id: String = "",
    val title: String = "",
    val date: String = "",
    val endDate: String = "",
    val time: String? = null,
    val endTime: String? = null,
    val startAt: String? = null,
    val endAt: String? = null,
    val durationMinutes: Int? = null,
    val allDay: Boolean = false,
    val location: String? = null,
    val taskId: String? = null,
    val isTask: Boolean = false,
) {
    val isTaskBlock: Boolean get() = isTask || !taskId.isNullOrBlank()
}

@Serializable
data class Prefs(
    val workStart: String = "08:00",
    val workEnd: String = "16:00",
    val eveningStart: String = "18:30",
    val eveningEnd: String = "21:00",
    val weekendStart: String = "10:00",
    val weekendEnd: String = "19:00",
)

@Serializable
data class Task(
    val id: String = "",
    val title: String = "",
    val status: String = "",
    val due: String? = null,
    val priority: String? = null,
    val assignee: String? = null,
    @SerialName("planner_lane") val plannerLane: String? = null,
    @SerialName("effort_minutes") val effortMinutes: Int? = null,
    @SerialName("project_name") val projectName: String? = null,
    @SerialName("is_overdue") val isOverdue: Boolean = false,
    @SerialName("effective_due") val effectiveDue: String? = null,
    @SerialName("dependency_deferred") val dependencyDeferred: Boolean = false,
    @SerialName("start") val start: String? = null,
    @SerialName("notes_preview") val notesPreview: String? = null,
    @SerialName("subtask_open") val subtaskOpen: Int = 0,
    @SerialName("subtask_total") val subtaskTotal: Int = 0,
) {
    val isOpen: Boolean get() = status == "needsAction"
    val isMine: Boolean get() = assignee.isNullOrBlank()
    /** The date the planner actually treats as due (dependency/start aware). */
    val dueForDisplay: String? get() = (effectiveDue ?: due)?.take(10)
}
