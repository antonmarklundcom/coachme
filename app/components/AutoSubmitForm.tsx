'use client';

/**
 * AutoSubmitForm — the one client boundary every writable section wraps its
 * controls in. A checkbox or radio submits the instant it is ticked; a text
 * field submits when it loses focus, not on every keystroke — together these
 * are "a checkbox tick or short-text edit writes straight to Neon" (plan.md
 * §6 S1) with no save button and no client-side state of its own: the server
 * action is the only source of truth, and `revalidatePath('/')` inside it
 * re-renders from Neon.
 *
 * The checkbox/text split matters more than it looks: React's `onChange`
 * fires per keystroke for a text input (it is wired to the native `input`
 * event, not `change`), so a single `onChange` on the form would resolve a
 * decision after its first typed character. Checked here by event target
 * type instead — `change` only acts on a checkbox/radio, `blur` only on a
 * text input.
 *
 * Enter still submits natively with JS disabled; this only adds the two
 * gestures HTML forms do not submit on by themselves.
 */

import { useRef, useTransition, type FocusEvent, type FormEvent, type ReactNode } from 'react';

export function AutoSubmitForm({
  action,
  children,
  className,
}: {
  action: (formData: FormData) => Promise<void>;
  children: ReactNode;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLFormElement>(null);

  const submit = () => {
    const form = ref.current;
    if (!form) return;
    const data = new FormData(form);
    startTransition(() => {
      action(data);
    });
  };

  const isToggle = (target: EventTarget) => target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type);
  const isText = (target: EventTarget) => target instanceof HTMLInputElement && target.type === 'text';

  const handleChange = (e: FormEvent<HTMLFormElement>) => {
    if (isToggle(e.target)) submit();
  };
  const handleBlur = (e: FocusEvent<HTMLFormElement>) => {
    if (isText(e.target)) submit();
  };

  return (
    <form
      ref={ref}
      className={className}
      data-pending={pending ? '' : undefined}
      onChange={handleChange}
      onBlur={handleBlur}
    >
      {children}
    </form>
  );
}
