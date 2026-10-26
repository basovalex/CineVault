package com.cinevault.android

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay

// Building blocks of the TV screens: everything is reached with the remote's arrows and OK.

/**
 * Remote focus, made to be seen from a sofa three metres away: the focused element grows and gets a white
 * outline; artwork ([glow]) also lights up around its edge, since a shadow alone is lost on a dark screen.
 */
@Composable
fun Modifier.tvFocus(
    shape: RoundedCornerShape = RoundedCornerShape(12.dp), scale: Float = 1.06f, glow: Boolean = false,
    interaction: MutableInteractionSource = remember { MutableInteractionSource() }, onClick: () -> Unit,
): Modifier {
    val focused by interaction.collectIsFocusedAsState()
    val grow by animateFloatAsState(if (focused) scale else 1f, label = "focus")
    return this
        .graphicsLayer { scaleX = grow; scaleY = grow }
        .then(if (focused && glow) Modifier.shadow(28.dp, shape, ambientColor = TvGold, spotColor = TvGold) else Modifier)
        .border(if (focused) BorderStroke(3.dp, Color.White) else BorderStroke(0.dp, Color.Transparent), shape)
        .clip(shape)
        .clickable(interactionSource = interaction, indication = null, onClick = onClick)
}

/** Small controls are filled white when focused (an outline alone is lost on older panels). */
@Composable
private fun rememberFocus(): Pair<MutableInteractionSource, Boolean> {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    return interaction to focused
}

@Composable
fun TvButton(
    text: String, primary: Boolean, onClick: () -> Unit, focus: FocusRequester? = null,
    icon: ImageVector? = null, iconTint: Color = Color.White, modifier: Modifier = Modifier,
) {
    val (interaction, focused) = rememberFocus()
    val content = if (focused || primary) Cine.Background else Color.White
    Row(
        modifier.then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .tvFocus(RoundedCornerShape(Cine.Radius), scale = 1.05f, interaction = interaction, onClick = onClick)
            .background(if (focused) Color.White else if (primary) TvGold else Cine.Surface2.copy(alpha = 0.92f))
            .padding(horizontal = 26.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, tint = if (focused || primary) content else iconTint); Spacer(Modifier.width(10.dp)) }
        Text(text, color = content, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

@Composable
fun TvChip(text: String, selected: Boolean, onClick: () -> Unit) {
    val (interaction, focused) = rememberFocus()
    Text(
        text, color = if (focused || selected) Cine.Background else Color.White, fontSize = 17.sp, fontWeight = FontWeight.Medium,
        modifier = Modifier.tvFocus(RoundedCornerShape(50), interaction = interaction, onClick = onClick)
            .background(if (focused) Color.White else if (selected) TvGold else Cine.Surface2).padding(horizontal = 20.dp, vertical = 10.dp),
    )
}

/** "Плеер · Alloha ▾": shows the current choice; OK opens the list. */
@Composable
fun TvSelect(label: String, value: String, onClick: () -> Unit, enabled: Boolean = true, focus: FocusRequester? = null) {
    val (interaction, focused) = rememberFocus()
    Row(
        Modifier.then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .tvFocus(RoundedCornerShape(Cine.Radius), interaction = interaction) { if (enabled) onClick() }
            .background(if (focused) Color.White else Cine.Surface2.copy(alpha = 0.92f))
            .padding(start = 18.dp, end = 12.dp, top = 8.dp, bottom = 8.dp).widthIn(min = 150.dp, max = 320.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f, fill = false)) {
            Text(label, color = if (focused) Cine.Background.copy(alpha = 0.65f) else Cine.Muted, fontSize = 13.sp)
            Text(value, color = if (focused) Cine.Background else Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (enabled) { Spacer(Modifier.width(8.dp)); Icon(Icons.Default.KeyboardArrowDown, null, tint = if (focused) Cine.Background else Cine.Muted) }
    }
}

/** A list to pick from with the remote; the current choice has the focus when it opens. */
@Composable
fun TvPickerDialog(title: String, options: List<String>, selected: Int, onPick: (Int) -> Unit, onDismiss: () -> Unit) {
    val focus = remember { FocusRequester() }
    val list = rememberLazyListState(initialFirstVisibleItemIndex = (selected - 2).coerceAtLeast(0))
    LaunchedEffect(Unit) { delay(80); runCatching { focus.requestFocus() } }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.width(460.dp).clip(RoundedCornerShape(18.dp)).background(Cine.Surface).padding(vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(title, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 24.dp))
            LazyColumn(Modifier.heightIn(max = 420.dp), state = list, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                itemsIndexed(options) { index, option ->
                    val isSelected = index == selected
                    val (interaction, focused) = rememberFocus()
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 14.dp)
                            .then(if (isSelected || (selected !in options.indices && index == 0)) Modifier.focusRequester(focus) else Modifier)
                            .tvFocus(RoundedCornerShape(12.dp), scale = 1.02f, interaction = interaction) { onPick(index) }
                            .background(if (focused) Color.White else if (isSelected) Cine.Surface2 else Color.Transparent).padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        val tint = if (focused) Cine.Background else if (isSelected) TvGold else Color.White
                        Text(option, color = tint, fontSize = 19.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        if (isSelected) Box(Modifier.size(24.dp)) { Icon(Icons.Default.Check, null, tint = if (focused) Cine.Background else TvGold) }
                    }
                }
            }
        }
    }
}
