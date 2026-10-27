/** Touch-friendly toggle (44 px hit area) for task/skill enabled states. */
export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={`relative h-7 w-12 min-w-[48px] rounded-full transition-colors ${
        props.checked ? 'bg-[var(--color-primary)]' : 'bg-[var(--border-color)]'
      }`}
    >
      <span
        className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${
          props.checked ? 'left-[24px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}
