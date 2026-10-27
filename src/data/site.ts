// Single source of truth for identity and links. Edit here; everything else reads from it.
const scholarUrl = 'https://scholar.google.com/citations?hl=en&user=4BrqERYAAAAJ&view_op=list_works&sortby=pubdate';

export const site = {
  scholar: scholarUrl,
  name: 'Chunyang Wang',
  nameNative: '王春阳',
  position: 'Ph.D. Student',
  affiliation: 'Imperial College London',
  affiliationUrl: 'https://www.imperial.ac.uk',
  tagline: ['AI for Physics', 'Multiphase Flow in Porous Media'],
  email: 'chunyang.w@outlook.com',
  description: "Chunyang Wang, Ph.D. student at Imperial College London working on AI for physics and multiphase flow in porous media.",
  avatar: '/img/avatar.webp',
  links: [
    { label: 'CV', href: '/files/cv.pdf' },
    { label: 'Google Scholar', href: scholarUrl },
    { label: 'GitHub', href: 'https://github.com/chunyang-w' },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/chunyang-wang-83135b201/' },
  ],
};
