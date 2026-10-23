// Shown for unknown admin addresses and to anyone who is not staff. Says nothing about the admin.
export default function AdminNotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-1 flex-col justify-center px-6 py-24 text-center">
      <p className="eyebrow">Page not found</p>
      <h1 className="mt-4 text-[clamp(40px,5vw,64px)] text-ink">Nothing here.</h1>
    </div>
  )
}
