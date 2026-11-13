package com.cinevault.android

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest

/** «Тёмный зал», the site's design (docs/DESIGN.md, app/styles.css :root), on a TV. */
object Hall {
    val Bg = Color(0xFF08090B)
    val Surface = Color(0xFF121418)
    val Surface2 = Color(0xFF1B1E24)
    val Surface3 = Color(0xFF262A31)
    val Text = Color(0xFFF5F6F7)
    val Text2 = Color(0xCCF5F6F7)
    val Muted = Color(0xFF9AA0A8)
    val Faint = Color(0xFF5D636C)
    val Accent = Color(0xFF5B9BFF)
    val AccentHover = Color(0xFF86B6FF)
    val AccentSoft = Color(0x245B9BFF)
    val OnAccent = Color(0xFF06142E)
    val Glass = Color(0x1FF5F6F7)
    val GlassHover = Color(0x38F5F6F7)
    val Line = Color(0x1AF5F6F7)
    val Scrim = Color(0xD108090B)
    val Track = Color(0x42F5F6F7)
    val SurfaceGlass = Color(0xD11B1E24)
    val Danger = Color(0xFFFF6B5E)
    val Gold = Color(0xFFF0BE50)
    val PlayerGlass = Color(0xD914161A)

    // Six steps of type, scaled for a screen three metres away.
    val S_1 = 13.sp
    val S0 = 15.sp
    val S1 = 17.sp
    val S2 = 22.sp
    val S3 = 30.sp
    val STitle = 44.sp

    val R = 10.dp
    val RLg = 14.dp
    val Gutter = 48.dp
    val RailWidth = 76.dp

    private fun body(weight: Int) = Font(com.cinevault.android.R.font.onest, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
    private fun display(weight: Int) = Font(com.cinevault.android.R.font.geologica, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
    val Body = FontFamily(body(400), body(500), body(600), body(700))
    val Display = FontFamily(display(600), display(700))
}

/** Text in the site's two faces: Geologica for titles and numbers, Onest for the rest. */
@Composable
fun HText(
    text: String, modifier: Modifier = Modifier, size: TextUnit = Hall.S0, color: Color = Hall.Text, weight: FontWeight = FontWeight.Normal,
    display: Boolean = false, maxLines: Int = Int.MAX_VALUE, align: TextAlign? = null, lineHeight: TextUnit = TextUnit.Unspecified,
) {
    Text(
        text, modifier, color = color, maxLines = maxLines, overflow = TextOverflow.Ellipsis, textAlign = align,
        style = TextStyle(fontFamily = if (display) Hall.Display else Hall.Body, fontWeight = weight, fontSize = size,
            lineHeight = if (lineHeight == TextUnit.Unspecified) size * 1.3f else lineHeight,
            letterSpacing = if (display) (-0.02).em(size) else TextUnit.Unspecified),
    )
}

private fun Double.em(size: TextUnit): TextUnit = (size.value * this).sp

/**
 * Remote focus, seen from a sofa: the focused element grows a little and gets a white ring.
 * The site's own :focus-visible is an accent outline; on a TV a white one reads on every picture.
 */
@Composable
fun Modifier.hallFocus(
    shape: RoundedCornerShape = RoundedCornerShape(Hall.RLg), scale: Float = 1.05f,
    interaction: MutableInteractionSource = remember { MutableInteractionSource() }, ring: Color = Color.White, onClick: () -> Unit,
): Modifier {
    val focused by interaction.collectIsFocusedAsState()
    val grow by animateFloatAsState(if (focused) scale else 1f, tween(160), label = "focus")
    return this
        .graphicsLayer { scaleX = grow; scaleY = grow }
        .border(if (focused) BorderStroke(3.dp, ring) else BorderStroke(0.dp, Color.Transparent), shape)
        .clip(shape)
        .clickable(interactionSource = interaction, indication = null, onClick = onClick)
}

@Composable
fun rememberFocused(): Pair<MutableInteractionSource, Boolean> {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    return interaction to focused
}

/** .primary-button / .secondary-button: accent for the one main action, glass for the rest. */
@Composable
fun HButton(
    text: String, onClick: () -> Unit, modifier: Modifier = Modifier, primary: Boolean = false, icon: ImageVector? = null,
    focus: FocusRequester? = null, busy: Boolean = false, enabled: Boolean = true, note: String? = null, big: Boolean = false,
) {
    val (interaction, focused) = rememberFocused()
    val background = when {
        !enabled -> Hall.Glass.copy(alpha = 0.06f)
        primary -> if (focused) Hall.AccentHover else Hall.Accent
        focused -> Hall.Text
        else -> Hall.Glass
    }
    val content = when {
        !enabled -> Hall.Faint
        primary -> Hall.OnAccent
        focused -> Hall.Bg
        else -> Hall.Text
    }
    Row(
        modifier.then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .hallFocus(RoundedCornerShape(Hall.RLg), interaction = interaction) { if (enabled && !busy) onClick() }
            .background(background)
            .padding(horizontal = if (big) 28.dp else 20.dp, vertical = if (big) 14.dp else 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) { Spinner(18.dp, content); Spacer(Modifier.width(10.dp)) }
        else if (icon != null) { Icon(icon, null, tint = content, modifier = Modifier.size(if (big) 24.dp else 20.dp)); Spacer(Modifier.width(10.dp)) }
        Column {
            HText(text, size = if (big) Hall.S1 else Hall.S0, color = content, weight = FontWeight.SemiBold, maxLines = 1)
            if (!note.isNullOrBlank()) HText(note, size = Hall.S_1, color = content.copy(alpha = 0.75f), maxLines = 1)
        }
    }
}

/** .genre-pill / .filter-button: surface pill, the active one lighter and bold. */
@Composable
fun HChip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, focus: FocusRequester? = null, badge: String? = null) {
    val (interaction, focused) = rememberFocused()
    Row(
        modifier.then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .hallFocus(RoundedCornerShape(50), scale = 1.06f, interaction = interaction, onClick = onClick)
            .background(if (focused) Hall.Text else if (selected) Hall.Surface3 else Hall.Surface)
            .padding(horizontal = 16.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HText(text, size = Hall.S0, color = if (focused) Hall.Bg else if (selected) Hall.Text else Hall.Muted,
            weight = if (selected) FontWeight.SemiBold else FontWeight.Medium, maxLines = 1)
        if (!badge.isNullOrBlank()) {
            Spacer(Modifier.width(8.dp))
            HText(badge, size = Hall.S_1, color = if (focused) Hall.Bg else Hall.Accent, weight = FontWeight.Bold, maxLines = 1)
        }
    }
}

@Composable
fun Spinner(size: Dp = 22.dp, color: Color = Hall.Accent) {
    val transition = rememberInfiniteTransition(label = "spin")
    val angle by transition.animateFloat(0f, 360f, infiniteRepeatable(tween(800, easing = LinearEasing), RepeatMode.Restart), label = "angle")
    Box(Modifier.size(size).graphicsLayer { rotationZ = angle }.drawBehind {
        val stroke = size.toPx() * 0.12f
        drawArc(Hall.Line, 0f, 360f, false, style = Stroke(stroke), topLeft = Offset(stroke / 2, stroke / 2), size = this.size.copy(this.size.width - stroke, this.size.height - stroke))
        drawArc(color, -90f, 90f, false, style = Stroke(stroke, cap = StrokeCap.Round), topLeft = Offset(stroke / 2, stroke / 2), size = this.size.copy(this.size.width - stroke, this.size.height - stroke))
    })
}

/** A line saying what is loading, with the spinner; [slow] adds the site's "отвечает медленно" hint. */
@Composable
fun StatusLine(text: String, busy: Boolean = true, slow: String? = null, modifier: Modifier = Modifier) {
    Column(modifier.clip(RoundedCornerShape(Hall.R)).background(Hall.Surface).padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (busy) { Spinner(18.dp); Spacer(Modifier.width(12.dp)) }
            HText(text, size = Hall.S0, color = Hall.Text2)
        }
        if (!slow.isNullOrBlank()) HText(slow, size = Hall.S_1, color = Hall.Gold)
    }
}

/**
 * A TMDB picture as the site loads it: our server first, one more try on error, then straight from
 * image.tmdb.org; when none comes, the title as text instead of an empty frame.
 */
@Composable
fun TvImage(url: String, title: String, modifier: Modifier = Modifier, scale: ContentScale = ContentScale.Crop, titleSize: TextUnit = Hall.S1) {
    var attempt by remember(url) { mutableIntStateOf(0) }
    Box(modifier) {
        if (url.isBlank() || attempt >= 3) {
            if (title.isNotBlank()) HText(title, Modifier.align(Alignment.Center).padding(12.dp), size = titleSize, color = Hall.Text2,
                weight = FontWeight.SemiBold, display = true, align = TextAlign.Center, maxLines = 4)
            return@Box
        }
        val context = LocalContext.current
        val target = if (attempt >= 2) Tmdb.directImage(url) else url
        val request = remember(target, attempt) {
            ImageRequest.Builder(context).data(target).apply {
                TvNet.serverHeaders(target).forEach { (name, value) -> if (name == "Authorization") addHeader(name, value) }
                if (attempt > 0) { memoryCacheKey("$target#$attempt"); setParameter("attempt", attempt) }
            }.build()
        }
        AsyncImage(request, null, Modifier.fillMaxSize(), contentScale = scale, onError = { attempt++ })
    }
}

/** The site's .poster-card: 2:3 art with the rating badge, title and «год · жанр» below. */
@Composable
fun TvPosterCard(item: TvItem, onClick: () -> Unit, modifier: Modifier = Modifier, width: Dp? = 132.dp, focus: FocusRequester? = null,
               progress: Double = 0.0, onFocus: () -> Unit = {}) {
    val (interaction, focused) = rememberFocused()
    if (focused) androidx.compose.runtime.LaunchedEffect(Unit) { onFocus() }
    Column(modifier.then(if (width != null) Modifier.width(width) else Modifier.fillMaxWidth()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(2f / 3f).then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
                .hallFocus(RoundedCornerShape(Hall.R), scale = 1.07f, interaction = interaction, onClick = onClick).background(Hall.Surface),
        ) {
            TvImage(Tmdb.image(item.poster, "w342"), item.title, Modifier.fillMaxSize())
            if (item.rating > 0) Badge(String.format(java.util.Locale.US, "%.1f", item.rating), Modifier.align(Alignment.TopStart).padding(6.dp))
            if (progress > 0) ProgressBar(progress, Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(8.dp))
        }
        Column {
            HText(item.title, size = Hall.S0, color = if (focused) Hall.Accent else Hall.Text, weight = FontWeight.SemiBold, maxLines = 1)
            val meta = listOfNotNull(item.year.takeIf { it > 0 }?.toString(), if (item.isSeries) "сериал" else item.genres.firstOrNull()).joinToString(" · ")
            if (meta.isNotBlank()) HText(meta, size = Hall.S_1, color = Hall.Muted, maxLines = 1)
        }
    }
}

@Composable
fun Badge(text: String, modifier: Modifier = Modifier, color: Color = Hall.Text, background: Color = Hall.Scrim) {
    HText(text, modifier.clip(RoundedCornerShape(6.dp)).background(background).padding(horizontal = 7.dp, vertical = 2.dp),
        size = Hall.S_1, color = color, weight = FontWeight.Bold, maxLines = 1)
}

@Composable
fun ProgressBar(share: Double, modifier: Modifier = Modifier) {
    Box(modifier.height(4.dp).clip(RoundedCornerShape(2.dp)).background(Hall.Track)) {
        Box(Modifier.fillMaxWidth(share.toFloat().coerceIn(0f, 1f)).height(4.dp).background(Hall.Accent))
    }
}

/** A landscape card (continue watching, feed, episodes): still or backdrop, a scrim and the copy over it. */
@Composable
fun WideCard(image: String, title: String, line: String, onClick: () -> Unit, modifier: Modifier = Modifier, width: Dp = 260.dp,
             kicker: String = "", progress: Double = 0.0, focus: FocusRequester? = null, fallback: String = "") {
    val (interaction, focused) = rememberFocused()
    Box(
        modifier.width(width).aspectRatio(16f / 9f).then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .hallFocus(RoundedCornerShape(Hall.R), interaction = interaction, onClick = onClick).background(Hall.Surface),
    ) {
        TvImage(image, fallback, Modifier.fillMaxSize(), titleSize = Hall.S0)
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.35f to Color.Transparent, 1f to Hall.Bg.copy(alpha = 0.92f))))
        Column(Modifier.align(Alignment.BottomStart).padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (kicker.isNotBlank()) HText(kicker, size = Hall.S_1, color = Hall.Accent, weight = FontWeight.SemiBold, maxLines = 1)
            HText(title, size = Hall.S0, color = Hall.Text, weight = FontWeight.SemiBold, maxLines = 1, display = true)
            if (line.isNotBlank()) HText(line, size = Hall.S_1, color = Hall.Text2, maxLines = 1)
            if (progress > 0) { Spacer(Modifier.height(4.dp)); ProgressBar(progress, Modifier.fillMaxWidth()) }
        }
        if (focused) Box(Modifier.fillMaxSize().background(Color.White.copy(alpha = 0.04f)))
    }
}

/**
 * How a TV page follows the remote: a focused element already fully in view stays put, so a row keeps its
 * heading on screen; one that is not is brought to a sixth of the way down.
 */
@OptIn(ExperimentalFoundationApi::class)
class TvPageScroll(private val top: Float = 0.12f, private val bottom: Float = 0.1f, private val target: Float = 0.16f) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        if (offset >= containerSize * top && offset + size + containerSize * bottom <= containerSize) return 0f
        val goal = if (size > containerSize * 0.7f) 0f else containerSize * target
        return offset - goal
    }
}

/** A row keeps the focused card a little in from the left edge, like Lampa. */
@OptIn(ExperimentalFoundationApi::class)
object TvRowScroll : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        val lead = containerSize * 0.06f
        return when {
            offset < lead -> offset - lead
            offset + size > containerSize - lead -> offset + size - (containerSize - lead)
            else -> 0f
        }
    }
}

/** .discovery-shelf: a heading (Geologica) and a row of cards walked with the arrows. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TvShelf(title: String, description: String = "", start: Dp = Hall.Gutter, content: LazyListScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (title.isNotBlank()) Column(Modifier.padding(start = start, end = Hall.Gutter)) {
            HText(title, size = Hall.S2, weight = FontWeight.SemiBold, display = true, maxLines = 1)
            if (description.isNotBlank()) HText(description, size = Hall.S_1, color = Hall.Muted, maxLines = 1)
        }
        CompositionLocalProvider(LocalBringIntoViewSpec provides TvRowScroll) {
            LazyRow(contentPadding = PaddingValues(start = start, end = Hall.Gutter, top = 10.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), content = content)
        }
    }
}

@Composable
fun PosterShelf(row: TvRow, onOpen: (TvItem) -> Unit, start: Dp = Hall.Gutter, onFocus: (TvItem) -> Unit = {}) {
    TvShelf(row.title, row.description, start) {
        items(row.items, key = { it.id }) { item -> TvPosterCard(item, { onOpen(item) }, onFocus = { onFocus(item) }) }
    }
}

/** .page-heading: a big Geologica title with a muted line under it. */
@Composable
fun PageHeading(title: String, note: String = "", modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        HText(title, size = Hall.S3, weight = FontWeight.SemiBold, display = true, maxLines = 1)
        if (note.isNotBlank()) HText(note, size = Hall.S0, color = Hall.Muted, maxLines = 2)
    }
}

@Composable
fun EmptyBlock(title: String, note: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Column(modifier.clip(RoundedCornerShape(Hall.RLg)).background(Hall.Surface).padding(28.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        HText(title, size = Hall.S2, weight = FontWeight.SemiBold, display = true)
        HText(note, size = Hall.S0, color = Hall.Muted)
        if (action != null) { Spacer(Modifier.height(6.dp)); action() }
    }
}

/** The page's ambience: the focused title's frame, dimmed, behind everything (the site's blurred glow). */
@Composable
fun BoxScope.Backdrop(image: String, title: String = "", strength: Float = 0.45f) {
    if (image.isBlank()) return
    TvImage(image, "", Modifier.matchParentSize().graphicsLayer { alpha = strength })
    Box(Modifier.matchParentSize().background(Brush.horizontalGradient(0f to Hall.Bg, 0.65f to Hall.Bg.copy(alpha = 0.55f), 1f to Hall.Bg.copy(alpha = 0.2f))))
    Box(Modifier.matchParentSize().background(Brush.verticalGradient(0.4f to Color.Transparent, 1f to Hall.Bg)))
}

@Composable
fun Dot(color: Color = Hall.Accent, size: Dp = 8.dp) { Box(Modifier.size(size).clip(CircleShape).background(color)) }
