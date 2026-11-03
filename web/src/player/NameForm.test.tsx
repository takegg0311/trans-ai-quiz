import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NameForm } from './NameForm';

afterEach(() => {
  cleanup();
});

describe('NameForm', () => {
  it('送信ボタンの文言を指定できる', () => {
    render(
      <NameForm defaultValue="たけ" disabled={false} submitLabel="変更する" onSubmit={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '変更する' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '参加する' })).toBeNull();
  });

  it('onCancel を渡さないときはキャンセルを出さない', () => {
    render(<NameForm defaultValue="" disabled={false} onSubmit={() => {}} />);
    expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull();
    expect(screen.getByRole('button', { name: '参加する' })).toBeTruthy();
  });

  it('onCancel を渡すとキャンセルが表示され、押すと呼ばれる', () => {
    const onCancel = vi.fn();
    render(
      <NameForm
        defaultValue="たけ"
        disabled={false}
        submitLabel="変更する"
        onSubmit={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('空白だけの名前では送信できない', () => {
    const onSubmit = vi.fn();
    render(
      <NameForm defaultValue="   " disabled={false} submitLabel="変更する" onSubmit={onSubmit} />,
    );
    expect(screen.getByRole('button', { name: '変更する' })).toHaveProperty('disabled', true);
    fireEvent.submit(screen.getByRole('button', { name: '変更する' }).closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
