import SwiftUI
import UIKit

// Design tokens shared with the website (app/styles.css, Movie Streaming UI Kit layer):
// near-black surfaces, grey secondary text, yellow ratings, green primary action.
extension Color {
    static let cineBackground = Color(hex: 0x0D0C0F)
    static let cineSurface = Color(hex: 0x17161B)
    static let cineSurface2 = Color(hex: 0x28262D)
    static let cineSurface3 = Color(hex: 0x3E3C43)
    static let cineText = Color.white
    static let cineTextSoft = Color(hex: 0xC9CED4)
    static let cineMuted = Color(hex: 0x9CA4AB)
    static let cineLine = Color.white.opacity(0.08)
    /// Active tab, links, progress. 6:1 on the background.
    static let cineAccent = Color(hex: 0x00A86B)
    /// Filled primary buttons: white text on it passes 4.5:1.
    static let cineButton = Color(hex: 0x00875A)
    static let cineRating = Color(hex: 0xFFCD1A)
    static let cineSteel = cineMuted

    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

extension Font {
    /// One place to switch the app to Rubik once the font is bundled.
    static func cine(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
}

enum CineMetrics {
    static let gutter: CGFloat = 20
    static let buttonRadius: CGFloat = 14
    static let posterRadius: CGFloat = 10
    static let tabBarHeight: CGFloat = 58
}

// MARK: - Buttons

struct CinePrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.cine(16, .semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Color.cineButton.opacity(configuration.isPressed ? 0.8 : 1))
            .clipShape(RoundedRectangle(cornerRadius: CineMetrics.buttonRadius))
    }
}

struct CineSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.cine(16, .medium))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Color.cineSurface.opacity(configuration.isPressed ? 1 : 0.7))
            .overlay(RoundedRectangle(cornerRadius: CineMetrics.buttonRadius).stroke(Color.white.opacity(0.18), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: CineMetrics.buttonRadius))
    }
}

/// Square 50×50 secondary action next to a primary button.
struct CineIconButtonStyle: ButtonStyle {
    var size: CGFloat = 50

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 19, weight: .medium))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color.cineSurface.opacity(configuration.isPressed ? 1 : 0.7))
            .overlay(RoundedRectangle(cornerRadius: CineMetrics.buttonRadius).stroke(Color.white.opacity(0.16), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: CineMetrics.buttonRadius))
    }
}

/// Round translucent button over artwork (back, share, favourite).
struct CineOverlayButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(Color.cineBackground.opacity(configuration.isPressed ? 0.8 : 0.55))
            .clipShape(Circle())
    }
}

// MARK: - Chips and segments

struct CineChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.cine(13, isSelected ? .semibold : .medium))
                .lineLimit(1)
                .padding(.horizontal, 14)
                .frame(minHeight: 34)
                .foregroundStyle(isSelected ? Color.cineBackground : .white)
                .background(isSelected ? Color.white : Color.clear)
                .overlay(Capsule().stroke(isSelected ? Color.clear : Color.white.opacity(0.12), lineWidth: 1))
                .clipShape(Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct CineSegmented<Value: Hashable>: View {
    let options: [(value: Value, title: String)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.value) { option in
                let isSelected = option.value == selection
                Button {
                    withAnimation(.easeOut(duration: 0.18)) { selection = option.value }
                } label: {
                    Text(option.title)
                        .font(.cine(14, isSelected ? .semibold : .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .foregroundStyle(isSelected ? Color.white : Color.cineMuted)
                        .frame(maxWidth: .infinity, minHeight: 38)
                        .background(isSelected ? Color.cineSurface2 : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 11))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(4)
        .background(Color.cineSurface)
        .clipShape(RoundedRectangle(cornerRadius: CineMetrics.buttonRadius))
    }
}

struct GenrePill: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.cine(12))
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Color.cineSurface2)
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct RatingBadge: View {
    let rating: Double

    var body: some View {
        Text("★ \(String(format: "%.1f", rating))")
            .font(.cine(11, .semibold))
            .foregroundStyle(Color.cineRating)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Color.cineBackground.opacity(0.78))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .accessibilityLabel("Оценка \(String(format: "%.1f", rating))")
    }
}

struct ShelfHeader: View {
    let title: String
    var subtitle: String = ""
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.cine(19, .semibold))
                    .foregroundStyle(.white)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.cine(13))
                        .foregroundStyle(Color.cineMuted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.cine(13, .medium))
                    .foregroundStyle(Color.cineAccent)
            }
        }
        .padding(.horizontal, CineMetrics.gutter)
    }
}

struct EmptyStateView: View {
    let systemImage: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Color.cineMuted)
            Text(title)
                .font(.cine(17, .semibold))
            Text(message)
                .font(.cine(14))
                .foregroundStyle(Color.cineMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .padding(.horizontal, CineMetrics.gutter)
    }
}

// MARK: - Images

struct CachedPosterImage<Placeholder: View>: View {
    let url: URL?
    let placeholder: Placeholder
    @State private var image: UIImage?

    init(url: URL?, @ViewBuilder placeholder: () -> Placeholder) {
        self.url = url
        self.placeholder = placeholder()
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder
            }
        }
        .task(id: url?.absoluteString) {
            image = nil
            guard let url else { return }
            image = await PosterImageCache.shared.image(for: url)
        }
    }
}

/// Poster with a gradient fallback that names the title when no artwork loads.
struct CatalogPosterArt: View {
    let title: CatalogTitle
    var showsRating = true

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                CachedPosterImage(url: title.posterURL.flatMap(URL.init(string:))) {
                    ZStack(alignment: .bottomLeading) {
                        LinearGradient(colors: [Color.cineSurface2, Color.cineSurface], startPoint: .topLeading, endPoint: .bottomTrailing)
                        Text(title.title)
                            .font(.cine(12, .semibold))
                            .foregroundStyle(.white)
                            .lineLimit(3)
                            .padding(8)
                    }
                }
                .frame(width: proxy.size.width, height: proxy.size.height)
                .clipped()
                if showsRating, let rating = title.rating, rating > 0 {
                    RatingBadge(rating: rating).padding(6)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipShape(RoundedRectangle(cornerRadius: CineMetrics.posterRadius))
        }
    }
}

/// Wide artwork: backdrop when the server has one, otherwise the poster.
struct BackdropArt: View {
    let title: CatalogTitle

    var body: some View {
        CachedPosterImage(url: (title.backdropURL ?? title.posterURL).flatMap(URL.init(string:))) {
            LinearGradient(colors: [Color.cineSurface2, Color.cineBackground], startPoint: .top, endPoint: .bottom)
        }
    }
}

/// Logo artwork when available, otherwise the title set large.
struct TitleLogo: View {
    let title: CatalogTitle
    var maxWidth: CGFloat = 250
    var maxHeight: CGFloat = 76
    var fontSize: CGFloat = 32

    var body: some View {
        if let logo = title.logoURL.flatMap(URL.init(string:)) {
            CachedPosterImage(url: logo) { titleText }
                .scaledToFit()
                .frame(maxWidth: maxWidth, maxHeight: maxHeight, alignment: .leading)
                .accessibilityLabel(title.title)
        } else {
            titleText
        }
    }

    private var titleText: some View {
        Text(title.title)
            .font(.cine(fontSize, .bold))
            .foregroundStyle(.white)
            .lineLimit(2)
            .minimumScaleFactor(0.7)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct PosterCard: View {
    let title: CatalogTitle
    var width: CGFloat = 124
    var showsMeta = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            CatalogPosterArt(title: title)
                .frame(width: width, height: width * 1.5)
            Text(title.title)
                .font(.cine(13, .medium))
                .foregroundStyle(.white)
                .lineLimit(1)
            if showsMeta {
                Text(title.shortMeta)
                    .font(.cine(11))
                    .foregroundStyle(Color.cineMuted)
                    .lineLimit(1)
            }
        }
        .frame(width: width, alignment: .leading)
        .contentShape(Rectangle())
    }
}

struct ProgressStrip: View {
    let fraction: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Rectangle().fill(Color.white.opacity(0.2))
                Rectangle().fill(Color.cineAccent).frame(width: proxy.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: 4)
        .accessibilityLabel("Просмотрено \(Int(fraction * 100))%")
    }
}
