import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {title:'Human Connection — A little human time',description:'A private prototype for warm, thoughtful one-to-one conversations.',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="en"><body>{children}</body></html>;}
