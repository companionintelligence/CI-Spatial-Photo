//! Photo Time Machine desktop app.
//!
//! A native window around the viewer build (`web-server/client/build`, embedded at compile
//! time). The app has no processing server of its own and no server address compiled in:
//! like the website, it asks for the user's server on first start and keeps the answer in
//! the webview's local storage (`web-server/client/src/utils/apiTarget.ts`).
//!
//! The one native behaviour is where links go. The viewer's links to ci.computer, the docs
//! and the shop are ordinary same-tab links. In an app window a same-tab link would replace
//! the app with a web page and leave no way back, so anything that is not one of the app's
//! own pages opens in the system browser instead, and the window stays where it was.
//!
//! The content security policy is left unset in tauri.conf.json on purpose: see
//! desktop/README.md ("Content security policy").
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Runtime, Url, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// True for the app's own pages: the bundled viewer, and the dev server under `tauri dev`.
///
/// macOS and Linux serve the bundle from `tauri://localhost`; Windows serves it from
/// `http://tauri.localhost` (`https://` if `useHttpsScheme` is ever turned on).
fn is_app_page(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" if url.host_str() == Some("tauri.localhost") => true,
        _ => dev_url.is_some_and(|dev| url.origin() == dev.origin()),
    }
}

/// True for links that belong in the system browser or mail client. Everything else that
/// is not an app page (about:, data:, blob:) stays in the window, where the viewer put it.
fn opens_in_browser(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// Whether the webview may follow a navigation. A link out of the app is handed to the
/// system browser and the navigation is cancelled.
fn allow_navigation<R: Runtime>(app: &AppHandle<R>, url: &Url, dev_url: Option<&Url>) -> bool {
    if is_app_page(url, dev_url) || !opens_in_browser(url) {
        return true;
    }
    open_in_browser(app, url);
    false
}

fn open_in_browser<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("could not open {url} in the system browser: {err}");
    }
}

fn main() {
    tauri::Builder::default()
        // The Rust handlers below open every off-app link. The plugin's own click script would
        // instead send target="_blank" links to the page-facing `open_url` command, which this
        // app doesn't grant, so those links would do nothing.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .setup(|app| {
            let handle = app.handle().clone();
            // The window is declared in tauri.conf.json with `create: false` and built here,
            // because the two link handlers can only be attached to a builder.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .expect("tauri.conf.json declares the main window");
            let dev_url = if tauri::is_dev() {
                app.config().build.dev_url.clone()
            } else {
                None
            };

            let nav_app = handle.clone();
            let popup_app = handle.clone();
            WebviewWindowBuilder::from_config(&handle, &config)?
                .on_navigation(move |url| allow_navigation(&nav_app, url, dev_url.as_ref()))
                // A modifier-click or `window.open`: never a second app window. A web link goes
                // to the browser, the same as a plain click.
                .on_new_window(move |url, _features| {
                    if opens_in_browser(&url) {
                        open_in_browser(&popup_app, &url);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Photo Time Machine");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_bundled_viewer_is_an_app_page_on_every_platform() {
        for page in [
            "tauri://localhost/",
            "tauri://localhost/view/abc_123",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
        ] {
            assert!(is_app_page(&url(page), None), "{page}");
        }
    }

    #[test]
    fn the_dev_server_is_an_app_page_only_when_it_is_the_dev_url() {
        let dev = url("http://localhost:3000");
        assert!(is_app_page(&url("http://localhost:3000/view/x"), Some(&dev)));
        assert!(!is_app_page(&url("http://localhost:3000/"), None));
        // The processing server on this machine is not a page the window should show.
        assert!(!is_app_page(&url("http://localhost:8000/healthz"), Some(&dev)));
    }

    #[test]
    fn the_viewers_outbound_links_go_to_the_browser() {
        for link in [
            "https://ci.computer",
            "https://ci.computer/core",
            "https://docs.ci.computer",
            "https://photo.ci.computer/view/abc",
            "http://example.com/",
            "mailto:someone@example.com",
        ] {
            let link = url(link);
            assert!(!is_app_page(&link, None), "{link}");
            assert!(opens_in_browser(&link), "{link}");
        }
    }

    #[test]
    fn lookalike_hosts_are_not_app_pages() {
        for link in [
            "http://tauri.localhost.example.com/",
            "https://localhost/",
            "http://evil.example/tauri.localhost",
        ] {
            assert!(!is_app_page(&url(link), None), "{link}");
        }
    }

    #[test]
    fn non_web_schemes_stay_in_the_window() {
        for link in ["about:blank", "data:text/plain,hi", "blob:tauri://localhost/1234"] {
            assert!(!opens_in_browser(&url(link)), "{link}");
        }
    }
}
