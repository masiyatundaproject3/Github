import { supabase } from '../core/net.js';
import { t } from '../core/i18n.js';
import { profiles } from '../data/profiles.js';
import { Sheet } from './sheet.js';
import { avatar, h } from './dom.js';

const displayText = value => typeof value === 'string' ? value.replace(/\b(?:null|undefined)\b/gi, '').trim() : '';

export class FollowersView {
  constructor({ openProfile }) {
    this.openProfile = openProfile;
    this.sheet = new Sheet({ title: t('followers'), className: 'followers-sheet', autoFocus: false });
  }

  async open(profile) {
    if (!profile?.id) return;
    const token = this.token = (this.token || 0) + 1;
    this.sheet.title = `${t('followers')} · ${displayText(profile.name) || t('profile')}`;
    this.sheet.body.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    this.sheet.open();
    try {
      const sb = await supabase();
      const { data: follows, error: followsError } = await sb.from('mw_follows')
        .select('follower_id').eq('following_id', profile.id).limit(200);
      if (followsError) throw followsError;
      if (token !== this.token) return;
      const ids = [...new Set((follows || []).map(row => String(row.follower_id || '')).filter(Boolean))];
      if (!ids.length) {
        this.sheet.body.replaceChildren(h('p', { class: 'muted center' }, t('noneYet')));
        return;
      }

      const { data: rows, error: profilesError } = await sb.from('mw_profiles')
        .select('id,display_name,username,avatar_url').in('id', ids);
      if (profilesError) throw profilesError;
      if (token !== this.token) return;
      const peopleById = new Map((rows || []).map(row => [String(row.id), {
        id: String(row.id),
        name: displayText(row.display_name) || 'MilkyWay',
        username: displayText(row.username),
        avatar: displayText(row.avatar_url),
      }]));
      const people = ids.map(id => peopleById.get(id) || profiles.peek(id)).filter(Boolean);
      profiles.prime(people);
      this.sheet.body.replaceChildren(...people.map(person => {
        const label = displayText(person.name) || displayText(person.username) || 'MilkyWay';
        const username = displayText(person.username);
        return h('button', { class: 'chat-row follower-row', type: 'button', onclick: () => {
          this.openProfile(person);
        } },
        avatar({ ...person, name: label }, 44),
        h('span', { class: 'chat-text' },
          h('b', {}, label),
          username ? h('span', { class: 'muted' }, `@${username}`) : null));
      }));
    } catch (error) {
      if (token !== this.token) return;
      this.sheet.body.replaceChildren(h('p', { class: 'muted center', role: 'status' },
        displayText(error?.message) || t('retry')));
    }
  }
}
