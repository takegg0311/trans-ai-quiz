type Props = {
  disabled: boolean;
  onBuzz: () => void;
};

/**
 * 早押しボタン。スペースキーでも同じ操作ができる（キー処理は App 側）。
 */
export function BuzzButton({ disabled, onBuzz }: Props) {
  return (
    <button
      type="button"
      className="buzz-button"
      onClick={onBuzz}
      disabled={disabled}
      aria-label="早押し"
    >
      <span className="buzz-button__inner">PUSH</span>
    </button>
  );
}
