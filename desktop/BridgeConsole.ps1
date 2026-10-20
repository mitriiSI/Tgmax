param(
  [string]$ServerUrl = "http://127.0.0.1:8080",
  [string]$PanelToken = ""
)
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Net.Http,Microsoft.VisualBasic
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="Bridge Console Desktop 2.2.0" Height="760" Width="1220" MinHeight="520" MinWidth="760" Background="#080B10" Foreground="#F8FBFF" WindowStartupLocation="CenterScreen">
<Window.Resources>
  <Style TargetType="Button"><Setter Property="Background" Value="#263D5A"/><Setter Property="Foreground" Value="#FFFFFF"/><Setter Property="BorderBrush" Value="#7890AC"/><Setter Property="BorderThickness" Value="2"/><Setter Property="FontWeight" Value="Bold"/><Setter Property="Padding" Value="12,7"/><Setter Property="MinHeight" Value="36"/></Style>
  <Style TargetType="TextBox"><Setter Property="Background" Value="#121D2B"/><Setter Property="Foreground" Value="#FFFFFF"/><Setter Property="CaretBrush" Value="#FFFFFF"/><Setter Property="BorderBrush" Value="#7890AC"/><Setter Property="BorderThickness" Value="2"/><Setter Property="Padding" Value="8"/></Style>
  <Style TargetType="ComboBox"><Setter Property="Background" Value="#121D2B"/><Setter Property="Foreground" Value="#FFFFFF"/><Setter Property="BorderBrush" Value="#7890AC"/><Setter Property="BorderThickness" Value="2"/><Setter Property="Padding" Value="5"/></Style>
  <Style TargetType="ComboBoxItem"><Setter Property="Background" Value="#F8FAFC"/><Setter Property="Foreground" Value="#101828"/><Setter Property="Padding" Value="8,5"/></Style>
  <Style TargetType="DataGridColumnHeader"><Setter Property="Background" Value="#1B2A40"/><Setter Property="Foreground" Value="#FFFFFF"/><Setter Property="BorderBrush" Value="#52657E"/><Setter Property="FontWeight" Value="Bold"/><Setter Property="Padding" Value="8"/></Style>
  <Style TargetType="DataGridCell"><Setter Property="Foreground" Value="#F8FBFF"/><Setter Property="BorderBrush" Value="#25364C"/><Setter Property="Padding" Value="6,3"/></Style>
</Window.Resources>
<Grid Margin="12"><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
<Border Grid.Row="0" Background="#0E131B" BorderBrush="#253142" BorderThickness="1" CornerRadius="10" Padding="12"><DockPanel><StackPanel DockPanel.Dock="Left"><TextBlock Text="Bridge Console Desktop" FontSize="20" FontWeight="Bold"/><TextBlock Text="Telegram ↔ MAX · нативное окно Windows" Foreground="#C7D5E6"/></StackPanel><StackPanel Orientation="Horizontal" HorizontalAlignment="Right"><Ellipse Name="StatusDot" Width="10" Height="10" Fill="#FF6B7A" Margin="0,0,8,0"/><TextBlock Name="StatusText" Text="Отключено" VerticalAlignment="Center"/></StackPanel></DockPanel></Border>
<Grid Grid.Row="1" Margin="0,10,0,10"><Grid.ColumnDefinitions><ColumnDefinition Width="2*"/><ColumnDefinition Width="*"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><TextBox Name="SearchBox" Grid.Column="0" Margin="0,0,8,0" ToolTip="Поиск"/><ComboBox Name="LevelBox" Grid.Column="1" Margin="0,0,8,0"><ComboBoxItem Content="Все уровни" Tag="" IsSelected="True"/><ComboBoxItem Content="INFO" Tag="info"/><ComboBoxItem Content="WARN" Tag="warn"/><ComboBoxItem Content="ERROR" Tag="error"/><ComboBoxItem Content="DEBUG" Tag="debug"/></ComboBox><ComboBox Name="AccountBox" Grid.Column="2" Margin="0,0,8,0"><ComboBoxItem Content="Все пользователи" Tag="" IsSelected="True"/></ComboBox><Button Name="PauseButton" Grid.Column="3" Content="Пауза" Margin="0,0,8,0" Padding="14,7"/><Button Name="ClearButton" Grid.Column="4" Content="Очистить" Padding="14,7"/></Grid>
<DataGrid Name="EventGrid" Grid.Row="2" AutoGenerateColumns="False" IsReadOnly="True" Background="#0A0F16" Foreground="#EDF3FB" BorderBrush="#253142" GridLinesVisibility="Horizontal" HorizontalGridLinesBrush="#182231" RowBackground="#0A0F16" AlternatingRowBackground="#0E141D" HeadersVisibility="Column" SelectionMode="Single"><DataGrid.Columns><DataGridTextColumn Header="Время" Binding="{Binding Time}" Width="115"/><DataGridTextColumn Header="Уровень" Binding="{Binding Level}" Width="70"/><DataGridTextColumn Header="Категория" Binding="{Binding Category}" Width="130"/><DataGridTextColumn Header="Пользователь" Binding="{Binding Account}" Width="160"/><DataGridTextColumn Header="Операция" Binding="{Binding Operation}" Width="170"/><DataGridTextColumn Header="Событие" Binding="{Binding Message}" Width="*"/></DataGrid.Columns></DataGrid>
<Border Grid.Row="3" Margin="0,10,0,0" Background="#0E131B" BorderBrush="#253142" BorderThickness="1" CornerRadius="8" Padding="8"><DockPanel><TextBlock Name="StatsText" Text="Событий: 0" Foreground="#C7D5E6"/><Button Name="OpenWebButton" Content="Открыть веб-панель" HorizontalAlignment="Right" Padding="12,5"/></DockPanel></Border>
</Grid></Window>
"@
$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)
$names = 'StatusDot','StatusText','SearchBox','LevelBox','AccountBox','PauseButton','ClearButton','EventGrid','StatsText','OpenWebButton'
foreach($name in $names){ Set-Variable -Name $name -Value $window.FindName($name) }

if([string]::IsNullOrWhiteSpace($PanelToken)){
  $PanelToken = [Microsoft.VisualBasic.Interaction]::InputBox('Введите PANEL_TOKEN из файла .env','Bridge Console','')
}
if([string]::IsNullOrWhiteSpace($PanelToken)){ [System.Windows.MessageBox]::Show('PANEL_TOKEN не введён.'); exit 1 }

$client = New-Object System.Net.Http.HttpClient
$events = New-Object System.Collections.ObjectModel.ObservableCollection[object]
$all = New-Object System.Collections.Generic.List[object]
$knownAccounts = New-Object System.Collections.Generic.HashSet[string]
$paused = $false
$lastSeq = 0
$EventGrid.ItemsSource = $events

function Get-Json([string]$Path){
  $uri = "$ServerUrl$Path" + ($(if($Path.Contains('?')){'&'}else{'?'})) + 'token=' + [uri]::EscapeDataString($PanelToken)
  $response = $client.GetAsync($uri).GetAwaiter().GetResult()
  if(-not $response.IsSuccessStatusCode){ throw "HTTP $([int]$response.StatusCode): $($response.Content.ReadAsStringAsync().GetAwaiter().GetResult())" }
  return ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json)
}
function Set-Status([bool]$Online,[string]$Text){ $StatusDot.Fill = if($Online){'#5FE0A0'}else{'#FF6B7A'}; $StatusText.Text=$Text }
function Convert-Event($e){
  [pscustomobject]@{ Seq=[int64]$e.seq; Raw=$e; Time=([datetime]$e.isoTime).ToLocalTime().ToString('HH:mm:ss.fff'); Level=([string]$e.level).ToUpper(); Category=[string]$e.category; Account=if($e.accountId){[string]$e.accountId}else{'—'}; Operation=if($e.operationId){([string]$e.operationId).Substring(0,[Math]::Min(18,([string]$e.operationId).Length))}else{'—'}; Message=[string]$e.message }
}
function Refresh-View{
  $query=$SearchBox.Text.ToLowerInvariant(); $selected=$LevelBox.SelectedItem; $level=if($selected){[string]$selected.Tag}else{''}; $accItem=$AccountBox.SelectedItem; $account=if($accItem){[string]$accItem.Tag}else{''}
  $events.Clear(); foreach($row in $all){ if($level -and $row.Raw.level -ne $level){continue}; if($account -and $row.Raw.accountId -ne $account){continue}; if($query -and ("$($row.Message) $($row.Raw.event) $($row.Raw.details|ConvertTo-Json -Compress -Depth 5)".ToLowerInvariant().IndexOf($query) -lt 0)){continue}; $events.Add($row) }
  $StatsText.Text="Событий на экране: $($events.Count) · Всего загружено: $($all.Count) · Последний seq: $lastSeq"
  if($events.Count -gt 0){ $EventGrid.ScrollIntoView($events[$events.Count-1]) }
}
function Add-Row($e){
  $row=Convert-Event $e; $all.Add($row); $script:lastSeq=[Math]::Max($script:lastSeq,[int64]$e.seq)
  if($e.accountId -and $knownAccounts.Add([string]$e.accountId)){ $item=New-Object System.Windows.Controls.ComboBoxItem; $item.Content=[string]$e.accountId; $item.Tag=[string]$e.accountId; $AccountBox.Items.Add($item)|Out-Null }
  while($all.Count -gt 5000){$all.RemoveAt(0)}
}

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromSeconds(1)
$timer.Add_Tick({
  if($paused){return}
  try{ $result=Get-Json "/api/console/events?after=$lastSeq&limit=1000"; foreach($e in @($result.events)){Add-Row $e}; if(@($result.events).Count -gt 0){Refresh-View}; Set-Status $true 'Онлайн' }catch{ Set-Status $false 'Нет связи' }
})
$PauseButton.Add_Click({$script:paused=-not $script:paused;$PauseButton.Content=if($script:paused){'Продолжить'}else{'Пауза'}})
$ClearButton.Add_Click({$all.Clear();$events.Clear();$StatsText.Text='Экран очищен'})
$SearchBox.Add_TextChanged({Refresh-View});$LevelBox.Add_SelectionChanged({Refresh-View});$AccountBox.Add_SelectionChanged({Refresh-View})
$OpenWebButton.Add_Click({Start-Process "$ServerUrl/console"})
$EventGrid.Add_MouseDoubleClick({if($EventGrid.SelectedItem){[System.Windows.MessageBox]::Show(($EventGrid.SelectedItem.Raw|ConvertTo-Json -Depth 12),'Полное событие')}})
$window.Add_Loaded({try{$result=Get-Json '/api/console/events?limit=1000';foreach($e in @($result.events)){Add-Row $e};Refresh-View;Set-Status $true 'Онлайн'}catch{Set-Status $false $_.Exception.Message};$timer.Start()})
$window.Add_Closed({$timer.Stop();$client.Dispose()})
$window.ShowDialog()|Out-Null
