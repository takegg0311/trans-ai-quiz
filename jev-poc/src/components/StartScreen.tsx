type Props = {
  label: string;
  disabled: boolean;
  error: string | null;
  onStart: () => void;
};

export function StartScreen({ label, disabled, error, onStart }: Props) {
  return (
    <div className="start-screen">
      {error !== null && <p className="error">{error}</p>}
      <button type="button" className="start-button" onClick={onStart} disabled={disabled}>
        {label}
      </button>
    </div>
  );
}
