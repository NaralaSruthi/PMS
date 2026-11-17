import { Modal } from 'antd';

// "Are you sure?" step shown after a review form passes validation and
// before it's actually sent — submitting is hard to undo (most forms become
// read-only). Hook form of Modal.confirm, so the dialog picks up the app's
// dark theme (the static Modal.confirm ignores ConfigProvider); render
// `contextHolder` once in the calling component. Returning onConfirm's
// promise from onOk keeps the dialog open with a spinner on the button until
// the submit finishes, so it can't be confirmed twice.
export function useSubmitConfirmation() {
  const [modal, contextHolder] = Modal.useModal();

  const confirmSubmit = (
    title: string,
    onConfirm: () => Promise<void> | void,
    { content = 'Are you sure you want to submit this form?', okText = 'Submit' }: { content?: string; okText?: string } = {}
  ) => {
    modal.confirm({
      title,
      content,
      okText,
      cancelText: 'Cancel',
      centered: true,
      onOk: () => onConfirm(),
    });
  };

  return { confirmSubmit, contextHolder };
}
