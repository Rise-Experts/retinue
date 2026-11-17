/**
 * The URL transform that keeps the app's own schemes alive through react-markdown.
 *
 * Found by clicking an artifact link in the deployed app and getting nothing. The DOM said why:
 *
 *     <a href="">Instagram New Product Launch Playbook</a>
 *
 * `defaultUrlTransform` allows `http`, `https`, `mailto`, `irc`, `ircs` and `xmpp` and returns `''` for
 * every other protocol. So `chorus-artifact:`, `chorus-media:` and `chorus:post/` were all blanked
 * before the `a` and `img` overrides ever saw them — `isArtifactRef('')` is false, and the link fell
 * through to the plain-anchor branch with no href.
 *
 * Three product features, each described in the system prompt by name, each implemented in the
 * renderer, each unreachable in a browser. `urlTransform` has never appeared in this repository's
 * history: the ref parsers are pure and were unit-tested, and nothing rendered them in a DOM.
 *
 * These assertions are on the transform rather than the components, for the same reason: the transform
 * is where the loss happened and it is pure.
 */
import { describe, expect, it } from 'vitest';

import { assistantUrlTransform } from '@/app/(dashboard)/assistant/Markdown';
import { ARTIFACT_SCHEME } from '../artifactRef';
import { MEDIA_REF_SCHEME } from '../mediaRef';
import { POST_TOKEN_SCHEME } from '../postToken';

const UUID = '8f14e45f-ceea-467a-9c1b-2f2b0d1a4d55';

describe('the app schemes survive', () => {
  it('keeps an artifact reference intact, so the chip can open the panel', () => {
    const href = `${ARTIFACT_SCHEME}${UUID}`;
    expect(assistantUrlTransform(href)).toBe(href);
  });

  it('keeps a post token intact, so the post card renders', () => {
    const href = `${POST_TOKEN_SCHEME}${UUID}`;
    expect(assistantUrlTransform(href)).toBe(href);
  });

  it('keeps a media reference intact, so a workspace file can be shown', () => {
    // Storage paths carry slashes and dots; none of that is a protocol.
    const href = `${MEDIA_REF_SCHEME}2db71d16/media/ethiopia-guji.png`;
    expect(assistantUrlTransform(href)).toBe(href);
  });

  it('is case-insensitive about the scheme, because the model writes the string', () => {
    expect(assistantUrlTransform(`CHORUS-ARTIFACT:${UUID}`)).toBe(`CHORUS-ARTIFACT:${UUID}`);
  });
});

describe('everything else still goes through the sanitiser', () => {
  it('strips a javascript: href', () => {
    // The reason the sanitiser exists. Reply text is model output, and model output can be steered by
    // a web page it read — so this must stay stripped whatever else changes.
    expect(assistantUrlTransform('javascript:alert(1)')).toBe('');
  });

  it('strips a data: href', () => {
    expect(assistantUrlTransform('data:text/html;base64,PHNjcmlwdD4=')).toBe('');
  });

  it('strips a vbscript: href', () => {
    expect(assistantUrlTransform('vbscript:msgbox(1)')).toBe('');
  });

  it('strips a scheme that merely looks like ours', () => {
    // `chorus-artifacts:` is not `chorus-artifact:`, and a near-miss must not become an allowance.
    expect(assistantUrlTransform('chorus-artifacts:whatever')).toBe('');
    expect(assistantUrlTransform('chorusartifact:whatever')).toBe('');
  });

  it('leaves ordinary links and relative paths alone', () => {
    expect(assistantUrlTransform('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(assistantUrlTransform('/dashboard')).toBe('/dashboard');
    expect(assistantUrlTransform('mailto:hi@example.com')).toBe('mailto:hi@example.com');
  });
});
