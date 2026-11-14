export interface ConfirmQuestion {
  title: string;
  preview: string;
  reason?: string;
  actionLabel: string;
}

export interface ConfirmRequest extends ConfirmQuestion {
  resolve: (ok: boolean) => void;
}

// The question waiting for an answer, and the one the dialog shows.
export interface ConfirmState {
  pending: ConfirmRequest | null;
  shown: ConfirmQuestion | null;
}

export const closedConfirm: ConfirmState = { pending: null, shown: null };

export function asked(request: ConfirmRequest): ConfirmState {
  const { resolve: _resolve, ...question } = request;
  return { pending: request, shown: question };
}

// The dialog closes, but keeps the question it asked while it fades out, so it never shows other words.
export function answered(state: ConfirmState): ConfirmState {
  return { pending: null, shown: state.shown };
}
