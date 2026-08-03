fn main() {
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("icons/icon.ico");
        res.set("ProductName", "Weport");
        res.set("FileDescription", "Weport — WeChat chat history exporter");
        res.set("CompanyName", "Weport");
        res.set("LegalCopyright", "Copyright © Weport");
        if let Err(e) = res.compile() {
            eprintln!("cargo:warning=winresource failed: {e}");
        }
    }
    println!("cargo:rerun-if-changed=icons/icon.ico");
}
