import puppyLogo from "./assets/puppygpt-wizard-logo.png"

export function Icon({ name, size = 20 }: { name: "plus" | "arrow" | "chat" | "folder" | "chevron" | "terminal" | "stop" | "panel" | "check" | "code" | "spark" | "search" | "settings" | "bell" | "copy" | "download" | "plug", size?: number }) {
    const paths = {
        plug: "M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0ZM12 18v4",
        download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
        copy: "M9 9h11v12H9ZM5 15H3V3h11v2",
        bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
        settings: "M4 7h16M4 17h16M9 4v6m6 4v6",
        plus: "M12 5v14M5 12h14",
        arrow: "M12 19V5m-6 6 6-6 6 6",
        chat: "M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z",
        folder: "M3 7V5h6l2 2h10v13H3Z",
        chevron: "m9 5 7 7-7 7",
        terminal: "m4 5 6 6-6 6m9 1h7",
        stop: "M6 6h12v12H6Z",
        panel: "M3 4h18v16H3Zm5 0v16",
        check: "m5 12 4 4L19 6",
        code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16",
        spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
        search: "M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    }
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

export function PuppyMark({ size = 32 }: { size?: number }) {
    return <img src={puppyLogo} width={size} height={size} alt="" aria-hidden="true" style={{ objectFit: "contain", flexShrink: 0 }} />
}
