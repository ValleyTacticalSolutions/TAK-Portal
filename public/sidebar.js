(() => {
    const btn = document.getElementById("sidebarToggle");
    const overlay = document.getElementById("sidebarOverlay");

    if (!btn || !overlay) return;

    function setOpen(open) {
        document.body.classList.toggle("sidebar-open", open);
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        overlay.setAttribute("aria-hidden", open ? "false" : "true");
    }

    btn.addEventListener("click", () => {
        setOpen(!document.body.classList.contains("sidebar-open"));
    });

    overlay.addEventListener("click", () => setOpen(false));

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") setOpen(false);
    });

    // If you resize back to desktop, close the mobile state
    const mq = window.matchMedia("(max-width: 900px)");
    mq.addEventListener?.("change", (e) => {
        if (!e.matches) setOpen(false);
    });
})();
