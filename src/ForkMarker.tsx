export function ForkMarker({ onSource, onMap }: { onSource?: () => void, onMap?: () => void }) {
    return <div className="branch-divider fork-marker">
        <svg width="16" height="18" viewBox="0 0 16 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="4" cy="3" r="2" /><circle cx="12" cy="3" r="2" /><circle cx="4" cy="15" r="2" />
            <path d="M4 5v8m8-8v2c0 3-8 2-8 5" />
        </svg>
        <span>Forked here</span>
        {onSource && <button type="button" onClick={onSource}>Source chat</button>}
        {onMap && <button type="button" onClick={onMap}>Branch map</button>}
    </div>
}
