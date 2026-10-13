import React from 'react'
import { Routes, Route, Navigate } from 'react-router'
import Layout from './components/Layout'
import { routes } from './routes'

export default function App() {
  return (
    <Layout>
      <Routes>
        {routes.map(({ path, element }) => (
          <Route key={path} path={path} element={element} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
