import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoSourceInfo } from '@/data/types';
import { PhotoError, type PreparedPhoto } from '@/lib/photos';
import { PhotoPicker } from './PhotoPicker';
import { usePhotoDraft } from './usePhotoDraft';

/** jsdom has no canvas: picks are "prepared" by a stub that keeps the file's bytes. */
const prepare = vi.fn(async (file: File): Promise<PreparedPhoto> => ({
  blob: new Blob([file], { type: 'image/jpeg' }),
  mime: 'image/jpeg',
  width: 2000,
  height: 1500,
  takenAt: '2026-10-09T15:30:00.000Z',
}));

const png = (name = 'deck.png') => new File(['png'], name, { type: 'image/png' });

let urls = 0;
beforeEach(() => {
  urls = 0;
  prepare.mockClear();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:photo-${++urls}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function Harness({
  initial,
  pdfMaxPhotos,
  reportDate,
}: {
  initial?: PhotoSourceInfo[];
  pdfMaxPhotos?: number;
  reportDate?: string;
}) {
  const draft = usePhotoDraft(initial, { prepare });
  return (
    <>
      <PhotoPicker
        draft={draft}
        timezone="America/Chicago"
        pdfMaxPhotos={pdfMaxPhotos}
        reportDate={reportDate}
      />
      <output data-testid="kept">{JSON.stringify(draft.kept())}</output>
      <output data-testid="changed">{String(draft.changed)}</output>
    </>
  );
}

const saved: PhotoSourceInfo[] = [
  {
    messageId: 'm1',
    storagePath: 'o/s/office/1.jpg',
    mime: 'image/jpeg',
    url: 'https://storage.test/1.jpg',
    caption: 'Rebar mats',
    takenAt: '2026-10-09T14:00:00.000Z',
  },
  {
    messageId: 'm2',
    storagePath: 'o/s/2.jpg',
    mime: 'image/jpeg',
    url: null,
    caption: null,
    takenAt: '2026-10-09T15:00:00.000Z',
  },
];

describe('PhotoPicker', () => {
  it('adds picked photos with previews, captions and a count, and removes them', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText('No photos yet.')).toBeInTheDocument();
    expect(screen.getByTestId('photo-count')).toHaveTextContent('0 photos of 20');

    await user.upload(screen.getByTestId('photo-input'), [png('a.png'), png('b.png')]);
    await waitFor(() => expect(screen.getAllByTestId('photo-thumb')).toHaveLength(2));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('photo-count')).toHaveTextContent('2 photos of 20');
    const thumbs = screen.getAllByTestId('photo-thumb');
    expect(thumbs.map((t) => t.getAttribute('src'))).toEqual(['blob:photo-1', 'blob:photo-2']);
    expect(screen.getByRole('img', { name: 'Photo 1' })).toBeInTheDocument();
    expect(screen.getAllByText('Taken Oct 9 · 10:30')).toHaveLength(2);

    // The caption is the photo's alt text.
    await user.type(screen.getByRole('textbox', { name: 'Caption for photo 2' }), 'South wall');
    expect(screen.getByRole('img', { name: 'South wall' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove photo 1' }));
    expect(screen.getAllByTestId('photo-item')).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-1');
    expect(screen.getByRole('textbox', { name: 'Caption for photo 1' })).toHaveValue('South wall');
    expect(screen.getByTestId('changed')).toHaveTextContent('true');
  });

  it('opens the file chooser from the Add photos button, without a capture attribute', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('photo-input');
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(input).toHaveAttribute('multiple');
    expect(input).not.toHaveAttribute('capture');
    const click = vi.spyOn(input, 'click');
    const add = screen.getByRole('button', { name: 'Add photos' });
    add.focus();
    await user.keyboard('{Enter}');
    expect(click).toHaveBeenCalledOnce();
  });

  it('explains files it cannot use: not an image, unreadable, over the limit', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<Harness />);
    prepare.mockImplementationOnce(async () => {
      throw new PhotoError('IMG_0012.HEIC is a HEIC photo this browser can’t open.');
    });
    await user.upload(screen.getByTestId('photo-input'), [
      new File(['%PDF'], 'plan.pdf', { type: 'application/pdf' }),
      new File(['heic'], 'IMG_0012.HEIC', { type: 'image/heic' }),
    ]);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('plan.pdf is not an image.');
    await waitFor(() =>
      expect(alert).toHaveTextContent('IMG_0012.HEIC is a HEIC photo this browser can’t open.'),
    );
    expect(screen.queryAllByTestId('photo-item')).toHaveLength(0);
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // 22 picks: 20 fit, the picker says what was left out and stops offering more.
    await user.upload(
      screen.getByTestId('photo-input'),
      Array.from({ length: 22 }, (_, i) => png(`p${i}.png`)),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A report holds up to 20 photos; 2 photos were not added.',
    );
    expect(screen.getAllByTestId('photo-item')).toHaveLength(20);
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeDisabled();
    expect(
      screen.getByText('A report holds up to 20 photos. Remove one to add another.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('photo-thumb')).toHaveLength(20));
  });

  it('starts an edit with the version’s photos, which can be re-captioned and removed', async () => {
    const user = userEvent.setup();
    render(<Harness initial={saved} />);
    expect(screen.getByRole('img', { name: 'Rebar mats' })).toHaveAttribute(
      'src',
      'https://storage.test/1.jpg',
    );
    // No preview (demo WhatsApp photo): a labelled placeholder.
    expect(screen.getByRole('img', { name: 'Photo 2' })).not.toHaveAttribute('src');
    expect(screen.getByRole('textbox', { name: 'Caption for photo 1' })).toHaveValue('Rebar mats');
    expect(screen.getByTestId('changed')).toHaveTextContent('false');

    const caption = screen.getByRole('textbox', { name: 'Caption for photo 2' });
    await user.type(caption, 'Formwork');
    await user.click(screen.getByRole('button', { name: 'Remove photo 1' }));
    expect(JSON.parse(screen.getByTestId('kept').textContent!)).toEqual([
      { messageId: 'm2', caption: 'Formwork', takenAt: '2026-10-09T15:00:00.000Z' },
    ]);
    expect(screen.getByTestId('changed')).toHaveTextContent('true');
    // A signed URL is not ours to revoke.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('moves photos, says how many the PDF prints and marks those', async () => {
    const user = userEvent.setup();
    render(<Harness initial={saved} pdfMaxPhotos={2} />);
    // Everything prints: nothing to say.
    expect(screen.queryByTestId('photo-pdf-hint')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('photo-in-pdf')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Move photo 1 earlier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move photo 2 later' })).toBeDisabled();

    await user.upload(screen.getByTestId('photo-input'), png('new.png'));
    await waitFor(() => expect(screen.getAllByTestId('photo-thumb')).toHaveLength(2));
    expect(screen.getByTestId('photo-pdf-hint')).toHaveTextContent(
      'The PDF prints the first 2; move the ones it should show to the front.',
    );
    const marked = () =>
      screen
        .getAllByTestId('photo-item')
        .map((li) => within(li).queryByTestId('photo-in-pdf') !== null);
    expect(marked()).toEqual([true, true, false]);

    // The new photo to the front: it prints, the WhatsApp photo m2 does not.
    await user.click(screen.getByRole('button', { name: 'Move photo 3 earlier' }));
    await user.click(screen.getByRole('button', { name: 'Move photo 2 earlier' }));
    expect(screen.getByRole('textbox', { name: 'Caption for photo 2' })).toHaveValue('Rebar mats');
    expect(JSON.parse(screen.getByTestId('kept').textContent!)).toEqual([
      { messageId: 'm1', caption: 'Rebar mats', takenAt: '2026-10-09T14:00:00.000Z' },
      { messageId: 'm2', takenAt: '2026-10-09T15:00:00.000Z' },
    ]);
    await user.click(screen.getByRole('button', { name: 'Move photo 3 earlier' }));
    expect(
      JSON.parse(screen.getByTestId('kept').textContent!).map(
        (p: { messageId: string }) => p.messageId,
      ),
    ).toEqual(['m2', 'm1']);
    expect(screen.getByTestId('changed')).toHaveTextContent('true');
  });

  it('dates a photo taken another day than the report’s', () => {
    render(<Harness initial={saved} reportDate="2026-10-08" />);
    // Oct 9 in Chicago: not the report's day.
    expect(screen.getByText('Taken Oct 9 · 09:00')).toBeInTheDocument();
    render(<Harness initial={saved} reportDate="2026-10-09" />);
    expect(screen.getByText('Taken 09:00')).toBeInTheDocument();
  });

  it('revokes the previews it made when it unmounts', async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    await user.upload(screen.getByTestId('photo-input'), [png('a.png'), png('b.png')]);
    await waitFor(() => expect(screen.getAllByTestId('photo-thumb')).toHaveLength(2));
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-2');
  });
});

describe('usePhotoDraft', () => {
  it('settles the picks, uploads each once per site in order and returns p_photos', async () => {
    const { result } = renderHook(() => usePhotoDraft(saved, { prepare }));
    act(() => result.current.add([png('a.png'), png('b.png')]));
    act(() => result.current.setCaption(result.current.items[3]!.key, '  East side '));
    const picked = await act(() => result.current.settle());
    expect(picked!.map((p) => p.caption)).toEqual(['', '  East side ']);

    let n = 0;
    const source = {
      uploadReportPhoto: vi.fn(async (siteId: string) => ({
        path: `org/${siteId}/office/${++n}.jpg`,
        mime: 'image/jpeg' as const,
      })),
    };
    const progress = vi.fn();
    const first = await result.current.upload(source, 'site-a', picked!, progress);
    expect(first).toEqual([
      {
        path: 'org/site-a/office/1.jpg',
        mime: 'image/jpeg',
        caption: null,
        takenAt: '2026-10-09T15:30:00.000Z',
        position: 2,
      },
      {
        path: 'org/site-a/office/2.jpg',
        mime: 'image/jpeg',
        caption: 'East side',
        takenAt: '2026-10-09T15:30:00.000Z',
        position: 3,
      },
    ]);
    expect(progress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
    // A retry after a failed save sends nothing again; another site uploads afresh.
    expect(await result.current.upload(source, 'site-a', picked!)).toEqual(first);
    expect(source.uploadReportPhoto).toHaveBeenCalledTimes(2);
    await result.current.upload(source, 'site-b', picked!);
    expect(source.uploadReportPhoto).toHaveBeenCalledTimes(4);
  });

  it('gives each pick its position in the list, after moves', async () => {
    const { result } = renderHook(() => usePhotoDraft(saved, { prepare }));
    act(() => result.current.add([png('a.png'), png('b.png')]));
    const [a, b] = result.current.items.slice(2).map((x) => x.key);
    // [m1, m2, a, b] → [a, m1, m2, b] → [a, m1, b, m2]
    act(() => result.current.move(a!, -1));
    act(() => result.current.move(a!, -1));
    act(() => result.current.move('saved:m2', 1));
    expect(result.current.items.map((x) => x.messageId ?? x.key)).toEqual([a, 'm1', b, 'm2']);
    expect(result.current.kept().map((p) => p.messageId)).toEqual(['m1', 'm2']);
    const picked = await act(() => result.current.settle());
    expect(picked!.map((p) => [p.key, p.position])).toEqual([
      [a, 0],
      [b, 2],
    ]);
    // Out-of-range moves change nothing.
    const before = result.current.items;
    act(() => result.current.move(result.current.items[0]!.key, -1));
    act(() => result.current.move(result.current.items.at(-1)!.key, 1));
    expect(result.current.items).toBe(before);
  });

  it('reports a pick that failed while saving, and resets to the report’s photos', async () => {
    const { result } = renderHook(() => usePhotoDraft(saved, { prepare }));
    prepare.mockImplementationOnce(async () => {
      throw new Error('decode failed');
    });
    act(() => result.current.add([png('broken.png')]));
    expect(await act(() => result.current.settle())).toBeNull();
    expect(result.current.errors).toEqual(['broken.png couldn’t be opened. Try a JPEG or PNG.']);
    expect(result.current.hasNew).toBe(false);
    expect(await act(() => result.current.settle())).toEqual([]);

    act(() => result.current.add([png('a.png')]));
    act(() => result.current.reset(saved));
    expect(result.current.items.map((x) => x.messageId)).toEqual(['m1', 'm2']);
    expect(result.current.changed).toBe(false);
    expect(await act(() => result.current.settle())).toEqual([]);
  });
});
