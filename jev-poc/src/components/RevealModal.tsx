/**
 * 全文・正解確認のモーダル。「次へ」はここにだけ置く。
 */
type Props = {
  text: string;
  answers: string[];
  onClose: () => void;
  onNext: () => void;
};

export function RevealModal({ text, answers, onClose, onNext }: Props) {
  const primary = answers[0] ?? '';
  const alts = answers.slice(1);

  return (
    <div className="reveal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="reveal-modal"
        role="dialog"
        aria-modal="true"
        aria-label="全文・正解確認"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="reveal-close"
          aria-label="閉じる"
          onClick={onClose}
        >
          ×
        </button>

        <h2 className="reveal-heading">問題文</h2>
        <p className="reveal-text">{text}</p>

        <h2 className="reveal-heading">正解</h2>
        <p className="reveal-answer">{primary}</p>
        {alts.length > 0 && (
          <p className="reveal-alts">別解: {alts.join(' / ')}</p>
        )}

        <div className="reveal-actions">
          <button type="button" className="primary-button" onClick={onNext}>
            次へ
          </button>
        </div>
      </div>
    </div>
  );
}
