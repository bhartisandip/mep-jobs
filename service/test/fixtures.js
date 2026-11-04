// Synthetic HTML shaped like LinkedIn's guest job cards (no real listings).
export function card({ id, title, company = 'Acme Building Services', location = 'Pune, Maharashtra, India', date = '2026-11-03' }) {
  return `<li>
    <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:${id}">
      <a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/some-slug-${id}?position=1&amp;pageNum=0&amp;refId=abc%3D%3D&amp;trackingId=xyz">
        <span class="sr-only">${title}</span></a>
      <div class="base-search-card__info">
        <h3 class="base-search-card__title">
          ${title}
        </h3>
        <h4 class="base-search-card__subtitle">
          <a class="hidden-nested-link" href="https://www.linkedin.com/company/acme">${company}</a>
        </h4>
        <div class="base-search-card__metadata">
          <span class="job-search-card__location">
            ${location}
          </span>
          <time class="job-search-card__listdate" datetime="${date}">1 day ago</time>
        </div>
      </div>
    </div>
  </li>`;
}

export const page = (cards) => cards.map(card).join('\n');
