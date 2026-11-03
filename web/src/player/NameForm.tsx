/** 参加時・名前変更時の名前入力。出題者用画面へ表示するために使う */
import { useState } from 'react';

type Props = {
  defaultValue: string;
  disabled: boolean;
  onSubmit: (name: string) => void;
  /** 省略時は「参加する」。名前変更時は「変更する」を渡す */
  submitLabel?: string;
  /** 渡したときだけキャンセルボタンを出す（参加時の見た目は変えない） */
  onCancel?: () => void;
};

export function NameForm({
  defaultValue,
  disabled,
  onSubmit,
  submitLabel = '参加する',
  onCancel,
}: Props) {
  const [value, setValue] = useState(defaultValue);
  const trimmed = value.trim();

  return (
    <form
      className="name-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed !== '') onSubmit(trimmed);
      }}
    >
      <label className="name-form-label" htmlFor="player-name">
        名前を入力してください
      </label>
      <input
        id="player-name"
        className="name-form-input"
        value={value}
        maxLength={12}
        autoComplete="off"
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="name-form-submit" disabled={disabled || trimmed === ''}>
        {submitLabel}
      </button>
      {onCancel !== undefined && (
        <button type="button" className="name-form-cancel" onClick={onCancel}>
          キャンセル
        </button>
      )}
    </form>
  );
}
