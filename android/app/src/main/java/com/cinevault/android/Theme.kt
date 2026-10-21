package com.cinevault.android

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.compose.SubcomposeAsyncImage

// Design tokens shared with the website and the iOS app: near-black surfaces,
// grey secondary text, yellow ratings, green primary action.
object Cine {
    val Background = Color(0xFF0D0C0F)
    val Surface = Color(0xFF17161B)
    val Surface2 = Color(0xFF28262D)
    val Surface3 = Color(0xFF3E3C43)
    val TextSoft = Color(0xFFC9CED4)
    val Muted = Color(0xFF9CA4AB)
    val Line = Color.White.copy(alpha = 0.08f)
    /** Active tab, links, progress. */
    val Accent = Color(0xFF00A86B)
    /** Filled primary buttons: white text on it stays readable. */
    val Button = Color(0xFF00875A)
    val Rating = Color(0xFFFFCD1A)
    val Gutter = 20.dp
    val Radius = 14.dp
    val PosterRadius = 10.dp
}

@Composable
fun CineVaultTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Cine.Accent,
            onPrimary = Color.White,
            background = Cine.Background,
            surface = Cine.Surface,
            surfaceVariant = Cine.Surface2,
            onBackground = Color.White,
            onSurface = Color.White,
            onSurfaceVariant = Cine.Muted,
            outline = Cine.Line,
        ),
        content = content,
    )
}

// MARK: Buttons

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    Row(
        modifier.heightIn(min = 50.dp).clip(RoundedCornerShape(Cine.Radius)).background(Cine.Button).clickable(onClick = onClick).padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, tint = Color.White, modifier = Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)) }
        Text(text, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1)
    }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    Row(
        modifier.heightIn(min = 50.dp).clip(RoundedCornerShape(Cine.Radius)).background(Cine.Surface.copy(alpha = 0.7f))
            .border(1.dp, Color.White.copy(alpha = 0.18f), RoundedCornerShape(Cine.Radius)).clickable(onClick = onClick).padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, tint = Color.White, modifier = Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)) }
        Text(text, color = Color.White, fontWeight = FontWeight.Medium, fontSize = 16.sp, maxLines = 1)
    }
}

/** Square 50×50 secondary action next to a primary button. */
@Composable
fun IconSquareButton(icon: ImageVector, description: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier.size(50.dp).clip(RoundedCornerShape(Cine.Radius)).background(Cine.Surface.copy(alpha = 0.7f))
            .border(1.dp, Color.White.copy(alpha = 0.16f), RoundedCornerShape(Cine.Radius)).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, description, tint = Color.White) }
}

/** Round translucent button over artwork (back, share, favourite). */
@Composable
fun OverlayButton(icon: ImageVector, description: String, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color = Color.White) {
    Box(
        modifier.size(44.dp).clip(CircleShape).background(Cine.Background.copy(alpha = 0.55f)).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, description, tint = tint, modifier = Modifier.size(22.dp)) }
}

// MARK: Chips and segments

@Composable
fun CineChip(title: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.heightIn(min = 34.dp).clip(CircleShape).background(if (selected) Color.White else Color.Transparent)
            .border(1.dp, if (selected) Color.Transparent else Color.White.copy(alpha = 0.12f), CircleShape)
            .clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(title, color = if (selected) Cine.Background else Color.White, fontSize = 13.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium, maxLines = 1)
    }
}

@Composable
fun <T> CineSegmented(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().clip(RoundedCornerShape(Cine.Radius)).background(Cine.Surface).padding(4.dp)) {
        options.forEach { (value, label) ->
            val isSelected = value == selected
            val background by animateColorAsState(if (isSelected) Cine.Surface2 else Color.Transparent, label = "segment")
            Box(
                Modifier.weight(1f).heightIn(min = 38.dp).clip(RoundedCornerShape(11.dp)).background(background).clickable { onSelect(value) },
                contentAlignment = Alignment.Center,
            ) {
                Text(label, color = if (isSelected) Color.White else Cine.Muted, fontSize = 14.sp, fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium, maxLines = 1)
            }
        }
    }
}

@Composable
fun GenrePill(text: String) {
    Text(
        text, color = Color.White, fontSize = 12.sp,
        modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Cine.Surface2).padding(horizontal = 10.dp, vertical = 5.dp),
    )
}

@Composable
fun RatingBadge(rating: Double, modifier: Modifier = Modifier) {
    Text(
        "★ " + String.format("%.1f", rating), color = Cine.Rating, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
        modifier = modifier.clip(RoundedCornerShape(6.dp)).background(Color.Black.copy(alpha = 0.62f)).padding(horizontal = 6.dp, vertical = 3.dp),
    )
}

// MARK: Artwork

@Composable
fun PosterImage(url: String?, title: String, modifier: Modifier = Modifier) {
    Box(modifier.clip(RoundedCornerShape(Cine.PosterRadius)).background(Cine.Surface2), contentAlignment = Alignment.Center) {
        if (url.isNullOrBlank()) {
            Text(title.take(1).uppercase(), color = Cine.Muted, fontSize = 28.sp, fontWeight = FontWeight.Bold)
        } else {
            AsyncImage(model = CineVaultApi.absoluteMediaURL(url), contentDescription = title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
    }
}

/** Poster with its rating, title and year below; the shape of every shelf and grid. */
@Composable
fun PosterCard(title: CatalogTitle, onClick: () -> Unit, modifier: Modifier = Modifier, width: Dp? = null) {
    Column(
        (if (width != null) modifier.width(width) else modifier).clickable(onClick = onClick),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box {
            PosterImage(title.poster, title.title, Modifier.fillMaxWidth().aspectRatio(2f / 3f))
            if (title.rating > 0) RatingBadge(title.rating, Modifier.padding(7.dp))
        }
        Text(title.title, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val sub = listOfNotNull(title.year.takeIf { it > 0 }?.toString(), title.genres.firstOrNull()).joinToString(" · ")
        if (sub.isNotBlank()) Text(sub, color = Cine.Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Wide artwork for heroes and title cards; falls back to the poster, then a gradient. */
@Composable
fun BackdropArt(title: CatalogTitle, modifier: Modifier = Modifier) {
    val url = title.backdrop ?: title.poster
    Box(modifier.background(Brush.verticalGradient(listOf(Cine.Surface2, Cine.Background)))) {
        if (!url.isNullOrBlank()) {
            AsyncImage(model = CineVaultApi.absoluteMediaURL(url), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
    }
}

/** Logo artwork when available, otherwise (or if the logo will not load) the title set large. */
@Composable
fun TitleLogo(title: CatalogTitle, maxWidth: Dp = 250.dp, maxHeight: Dp = 76.dp, fontSize: Int = 32) {
    val name: @Composable () -> Unit = {
        Text(title.title, color = Color.White, fontSize = fontSize.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = (fontSize + 4).sp)
    }
    if (!title.logo.isNullOrBlank()) {
        SubcomposeAsyncImage(
            model = CineVaultApi.absoluteMediaURL(title.logo), contentDescription = title.title,
            contentScale = ContentScale.Fit, alignment = Alignment.CenterStart,
            modifier = Modifier.width(maxWidth).height(maxHeight),
            loading = {},
            error = { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.CenterStart) { name() } },
        )
    } else {
        name()
    }
}

/** "★ 8.0 · IMDb 8.1 · 2026 · фантастика · 2 ч 25 мин" */
@Composable
fun MetaLine(title: CatalogTitle, withAge: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        if (title.rating > 0) Text("★ " + String.format("%.1f", title.rating), color = Cine.Rating, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        val parts = listOfNotNull(
            title.imdbRating.takeIf { it > 0 }?.let { "IMDb " + String.format("%.1f", it) },
            title.year.takeIf { it > 0 }?.toString(),
            title.genres.firstOrNull(),
            if (title.isSeries) title.seasons.size.takeIf { it > 0 }?.let { "$it сез." }
            else title.runtime.takeIf { it > 0 }?.let { if (it >= 60) "${it / 60} ч ${it % 60} мин" else "$it мин" },
        )
        Text(parts.joinToString(" · "), color = Cine.TextSoft, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (withAge && title.ageRating.isNotBlank()) {
            Text(
                title.ageRating.let { if (it.endsWith("+")) it else "$it+" }, color = Color.White, fontSize = 12.sp,
                modifier = Modifier.border(BorderStroke(1.dp, Color.White.copy(alpha = 0.35f)), RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
    }
}

@Composable
fun ShelfHeader(title: String, subtitle: String? = null, action: String? = null, onAction: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(horizontal = Cine.Gutter), verticalAlignment = Alignment.Bottom) {
        Column(Modifier.weight(1f)) {
            Text(title, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
            if (!subtitle.isNullOrBlank()) Text(subtitle, color = Cine.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (action != null && onAction != null) Text(action, color = Cine.Accent, fontSize = 15.sp, fontWeight = FontWeight.Medium, modifier = Modifier.clickable(onClick = onAction))
    }
}

@Composable
fun EmptyState(icon: ImageVector, title: String, message: String, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, null, tint = Cine.Muted, modifier = Modifier.size(40.dp))
        Text(title, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        Text(message, color = Cine.Muted, fontSize = 14.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}
