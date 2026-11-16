import SwiftUI

/// The site's account in Settings: sign in, create an account or reset the password with the recovery code.
struct AccountSection: View {
    @EnvironmentObject private var store: AppStore
    @State private var mode: Mode = .login
    @State private var username = ""
    @State private var displayName = ""
    @State private var password = ""
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?

    enum Mode: Hashable { case login, register, recover }

    var body: some View {
        Section {
            if let user = store.accountUser {
                LabeledContent("Аккаунт", value: user)
                if let code = store.pendingRecoveryCode {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Код восстановления").font(.footnote.weight(.semibold))
                        Text(code).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        Text("Запишите его: только с ним можно сменить забытый пароль.").font(.footnote).foregroundStyle(Color.cineMuted)
                        Button("Я записал(а)") { store.acknowledgeRecoveryCode() }
                    }
                }
                Button(store.accountSyncing ? "Синхронизирую…" : "Синхронизировать") { Task { await store.syncAccount() } }
                    .disabled(store.accountSyncing)
                Button("Выйти", role: .destructive) { Task { await store.logout() } }
                if let error = store.accountError { Text(error).font(.footnote).foregroundStyle(.orange) }
            } else {
                Picker("Действие", selection: $mode) {
                    Text("Вход").tag(Mode.login)
                    Text("Новый").tag(Mode.register)
                    Text("Сброс").tag(Mode.recover)
                }
                .pickerStyle(.segmented)
                TextField("Логин", text: $username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.username)
                if mode == .register {
                    TextField("Имя (как вас показывать)", text: $displayName)
                }
                if mode == .recover {
                    TextField("Код восстановления", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                }
                SecureField(mode == .recover ? "Новый пароль" : "Пароль", text: $password)
                    .textContentType(mode == .login ? .password : .newPassword)
                Button(busy ? "Подождите…" : title) { Task { await submit() } }
                    .disabled(busy || username.isEmpty || password.isEmpty || (mode == .recover && code.isEmpty))
                if let error { Text(error).font(.footnote).foregroundStyle(.orange) }
            }
        } header: {
            Text("Аккаунт сайта")
        } footer: {
            Text(store.accountUser == nil
                 ? "С аккаунтом избранное, история и место, где остановились, общие с сайтом и телевизором."
                 : "Избранное, история и прогресс общие с сайтом и телевизором.")
        }
    }

    private var title: String {
        switch mode {
        case .login: return "Войти"
        case .register: return "Создать аккаунт"
        case .recover: return "Сменить пароль"
        }
    }

    private func submit() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let name = username.trimmingCharacters(in: .whitespaces)
            switch mode {
            case .login: try await store.login(username: name, password: password)
            case .register: try await store.register(username: name, displayName: displayName, password: password)
            case .recover: try await store.recover(username: name, code: code, newPassword: password)
            }
            password = ""
            code = ""
        } catch {
            self.error = error.localizedDescription
        }
    }
}
