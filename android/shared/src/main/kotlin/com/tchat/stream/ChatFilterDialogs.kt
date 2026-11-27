package com.tchat.stream

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun HideMessageDialog(
    message: ChatMessage,
    filters: ChatFilters,
    onChange: (ChatFilters) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Скрыть из чата") },
        text = {
            Column {
                if (message.author.isNotEmpty()) {
                    TextButton(
                        onClick = { onChange(filters.copy(authors = filters.authors + chatFilterKey(message.author))) },
                    ) { Text("Пользователь «${message.author}»") }
                }
                TextButton(
                    onClick = { onChange(filters.copy(kinds = filters.kinds + message.kind.name)) },
                ) { Text("Тип «${message.kind.label}»") }
                if (message.text.isNotEmpty()) {
                    TextButton(
                        onClick = { onChange(filters.copy(messages = filters.messages + chatFilterKey(message.text))) },
                    ) { Text("Сообщения с таким текстом") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Отмена") } },
    )
}

@Composable
internal fun ChatFiltersDialog(filters: ChatFilters, onChange: (ChatFilters) -> Unit, onDismiss: () -> Unit) {
    var newAuthor by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Фильтры чата") },
        text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                OutlinedTextField(newAuthor, { newAuthor = it }, Modifier.fillMaxWidth(), singleLine = true,
                    label = { Text("Ник автора") })
                TextButton(enabled = chatFilterKey(newAuthor).let { it.isNotEmpty() && it !in filters.authors },
                    onClick = {
                        onChange(filters.copy(authors = filters.authors + chatFilterKey(newAuthor)))
                        newAuthor = ""
                    }) { Text("Скрыть автора") }
                ChatKind.entries.forEach { kind ->
                    val visible = kind.name !in filters.kinds
                    Row(
                        Modifier.fillMaxWidth().toggleable(visible, role = Role.Switch) { show ->
                            onChange(filters.copy(kinds = if (show) filters.kinds - kind.name else filters.kinds + kind.name))
                        }.padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(kind.label, Modifier.weight(1f))
                        Switch(checked = visible, onCheckedChange = null)
                    }
                }
                if (filters.authors.isNotEmpty()) {
                    Text("Скрытые пользователи", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.titleSmall)
                    filters.authors.sorted().forEach { author ->
                        TextButton(onClick = { onChange(filters.copy(authors = filters.authors - author)) }) {
                            Text("Показать «$author»")
                        }
                    }
                }
                if (filters.messages.isNotEmpty()) {
                    Text("Скрытые сообщения", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.titleSmall)
                    filters.messages.sorted().forEach { message ->
                        TextButton(onClick = { onChange(filters.copy(messages = filters.messages - message)) }) {
                            Text("Показать «$message»", maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Готово") } },
    )
}
