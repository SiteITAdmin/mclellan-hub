package scot.mclellan.boox

import kotlinx.serialization.Serializable

/**
 * The shape of GET /api/boox/sync. Only the fields the app renders are declared;
 * the JSON decoder ignores everything else (ignoreUnknownKeys), so the server
 * can add fields without breaking an already-installed build. Storing the raw
 * body offline (see SyncRepository) preserves the fields this model drops.
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
    val unscheduledTasks: List<Task> = emptyList(),
)

@Serializable
data class Day(
    val date: String = "",
    val label: String = "",
)

@Serializable
data class Task(
    val id: String = "",
    val title: String = "",
    val status: String = "",
    val due: String? = null,
    val priority: String? = null,
    val assignee: String? = null,
) {
    val isOpen: Boolean get() = status == "needsAction"
}
