"use client"

import React from "react"
import { useGlobal } from "@/lib/context/GlobalContext"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components-v2/ui/card"
import { Input } from "@/components-v2/ui/input"
import { Button } from "@/components-v2/ui/button"

export default function SettingsPage() {
  const { user } = useGlobal()

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Manage your account settings</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your account information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <Input value={user?.email || ""} disabled className="bg-gray-50" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">User ID</label>
            <Input value={user?.id || ""} disabled className="bg-gray-50 font-mono text-xs" />
          </div>
          <Button variant="outline">Change Password</Button>
        </CardContent>
      </Card>
    </div>
  )
}
